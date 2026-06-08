/**
 * LiveSmcOrchestrator — closes the gap between V6-alt's per-pair backtest
 * and live trading.
 *
 * The legacy SmcLiveEvaluator was stateless: each M15 close was an isolated
 * evaluation, and a sweep detected on the latest closed H1 had ONE chance
 * to fire. V6-alt's runSmcBacktest, by contrast, maintains a `pending`
 * queue: a sweep stays valid for `cfg.setupExpiryH1Bars` H1 bars and any
 * M15 bar in that window can take it (after passing the trade gates).
 *
 * This orchestrator replicates that queue + cooldown behavior on top of
 * the same sweep-detector + risk-manager primitives. Both the live engine
 * and the live-replay engine call into this so backtest behavior maps
 * 1:1 to live behavior.
 *
 * State is held per-symbol in memory; we expose serialize()/restore() so
 * the live engine can survive container restarts via Redis.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { RedisService } from '@app/redis';
import { computeIndicators } from '../../backtest/engine/indicator-calculator';
import { getInstrumentConfig } from '../../backtest/engine/instrument-config';
import { RiskManager } from '../../backtest/engine/risk-manager';
import { getSmcPairConfig } from '../../backtest/engine/smc/pairs';
import { detectSweep, findSweptSwingIdx } from '../../backtest/engine/smc/sweep-detector';
import { hasSupportingFvg, sweptMoveLeftFvg } from '../../backtest/engine/smc/fvg-detector';
import { hasSupportingOb, hasFreshObAtSweptLevel } from '../../backtest/engine/smc/order-block-detector';
import { hasBosAfter, sweptLevelWasItselfABos } from '../../backtest/engine/smc/bos-detector';
import { getD1Bias } from '../../backtest/engine/strategy-evaluator';
import { BacktestCandle, D1Bias, EngineConfig, IndicatorState } from '../../backtest/engine/types';
import { PendingSetup, SmcMode } from '../../backtest/engine/smc/types';
import { SmcLiveSignal } from './smc-live-evaluator';

/**
 * Optional precomputed indicators — replay passes these so we don't
 * recompute O(n) indicator arrays on every M15 close (drops the replay
 * from O(n²) to O(n)). Live leaves these unset and computeIndicators is
 * called fresh each call (still <50ms on the live buffers).
 */
export interface PrecomputedIndicators {
  m15: IndicatorState;
  h1: IndicatorState;
  d1: IndicatorState | null;
}

/** Per-pair runtime state. Lifetime: until session end / process restart. */
export interface OrchestratorState {
  /** Sweeps detected on closed H1 bars, awaiting an M15 entry. */
  pending: PendingSetup[];
  /** openTime of the last H1 bar we ran sweep detection on (avoids reprocessing). */
  lastProcessedH1Time: string | null;
  /** Number of M15 bars to skip before we can fire a new entry.
   *  Decrements once per evaluate() call (= once per M15 close). Mirrors
   *  V6-alt's `cooldownUntil = i + N` bar-index logic exactly: weekend gaps
   *  are skipped because we only count actual evaluator invocations. */
  cooldownBarsRemaining: number;
  /** H1-sweep openTimes already entered this session (legacy dedup). */
  actionedSweeps: Set<string>;
  /** V6-alt RiskManager — gates trades on daily loss, consecutive losses,
   *  rolling 7-day losses, drawdown pauses. Without this we take low-quality
   *  setups V6-alt would skip during slumps. Per-pair to match V6-alt. */
  riskManager: RiskManager;
}

/** Read-only telemetry snapshot exposed to the dashboard. Does not include
 *  RiskManager internals (those are reconstructed from trade history) and
 *  does not include actionedSweeps (large set, not user-facing). */
export interface OrchestratorTelemetry {
  pendingCount: number;
  lastProcessedH1Time: string | null;
  cooldownBarsRemaining: number;
  pending: Array<{
    direction: 'BUY' | 'SELL';
    mode: SmcMode;
    /** sweepMid — used as entry hint, mirrors what the engine would fire at. */
    entryHint: number;
    detectedAtH1Idx: number;
    expiresAtH1Idx: number;
  }>;
}

export interface LiveContext {
  accountEquity: number;
  /** Open positions on this pair (drives same-direction stacking guard). */
  openDirections: Set<'BUY' | 'SELL'>;
  /** Total open positions across all pairs (drives portfolio cap). */
  totalOpenPositions: number;
  /** Risk-per-trade % override; falls back to env RISK_PERCENT. */
  riskPercent?: number;
  /** Now() — the candle openTime when called from replay; Date.now() in live. */
  nowIso: string;
  /** Maximum simultaneous open positions across the account. Optional cap. */
  maxOpenPositions?: number;
}

@Injectable()
export class LiveSmcOrchestrator {
  /** Strategy identifier — written to Trade.strategyName + LiveReplayTrade.strategyName
   *  for analytics. Single-strategy today; literal constant. */
  readonly name = 'stop-hunt';

  private readonly logger = new Logger(LiveSmcOrchestrator.name);
  private readonly states = new Map<string, OrchestratorState>();

  /**
   * RedisService is optional so the replay path (`new LiveSmcOrchestrator()`
   * in replay-worker.ts) can still construct without DI. When omitted,
   * `restoreFromRedis` / `persistToRedis` / `migrateLegacyKeyOnce` are no-ops.
   */
  constructor(
    @Optional() @Inject(RedisService) private readonly redis?: RedisService,
  ) {}

  /** Reset state for a symbol — call when starting a fresh session. */
  reset(symbol: string): void {
    this.states.delete(symbol);
  }

  resetAll(): void {
    this.states.clear();
  }

  /** Override the initial balance/risk used to seed new RiskManager states.
   *  Replay calls this once before run; live uses defaults from env. */
  defaultRiskCfg: { initialBalance: number; riskPercent: number; maxOpenPositions: number } = {
    initialBalance: 10000,
    riskPercent: 1.5,
    maxOpenPositions: 4,
  };

  setDefaultRiskCfg(cfg: { initialBalance: number; riskPercent: number; maxOpenPositions: number }): void {
    this.defaultRiskCfg = cfg;
  }

  /** Snapshot — for Redis persistence. Captures pending sweeps, cooldown,
   *  actionedSweeps dedup set, AND the RiskManager state per pair so safety
   *  brakes (daily-loss cap, consecutive-loss pause, drawdown brake,
   *  hard-kill) survive container restarts. Without the RiskManager
   *  inclusion a deploy mid-cooldown would silently re-arm the engine. */
  serialize(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [sym, s] of this.states.entries()) {
      out[sym] = {
        pending: s.pending,
        lastProcessedH1Time: s.lastProcessedH1Time,
        cooldownBarsRemaining: s.cooldownBarsRemaining,
        actionedSweeps: Array.from(s.actionedSweeps),
        riskManager: s.riskManager.snapshot(),
      };
    }
    return out;
  }

  restore(snapshot: Record<string, any>): void {
    this.states.clear();
    for (const [sym, raw] of Object.entries(snapshot ?? {})) {
      const riskManager = this.buildRiskManager(sym);
      // Backwards-compatible: legacy snapshots without the riskManager key
      // fall through to a fresh instance (same behavior as before this
      // fix). New snapshots re-hydrate every safety-brake field.
      if (raw.riskManager && typeof raw.riskManager === 'object') {
        riskManager.restore(raw.riskManager);
      }
      // Drop any pending setup that lacks sweepTime — those were created
      // under the pre-PR-31 schema and the new fire/commit path requires
      // sweepTime to match setups stably. They'd otherwise sit in the
      // queue and be skipped (failing the actionedSweeps dedup check by
      // comparing undefined). Cleaner to discard them at restore time.
      const pending = (raw.pending ?? []).filter((p: { sweepTime?: string }) =>
        typeof p.sweepTime === 'string' && p.sweepTime.length > 0,
      );
      this.states.set(sym, {
        pending,
        lastProcessedH1Time: raw.lastProcessedH1Time ?? null,
        // Migrate legacy snapshots: if we see the old wall-clock field,
        // reset the bar counter (better than incorrectly translating times).
        cooldownBarsRemaining: typeof raw.cooldownBarsRemaining === 'number' ? raw.cooldownBarsRemaining : 0,
        actionedSweeps: new Set(raw.actionedSweeps ?? []),
        riskManager,
      });
    }
  }

  /**
   * Read account-scoped snapshot from Redis and restore in-memory state.
   * When accountId is omitted, reads the legacy unsuffixed key (preserves
   * single-account behavior during multi-account rollout).
   * No-op when this orchestrator was instantiated without RedisService
   * (e.g. in the replay-worker code path).
   */
  async restoreFromRedis(accountId?: string): Promise<void> {
    if (!this.redis) return;
    const key = accountId
      ? `live:orchestrator:state:${accountId}`
      : 'live:orchestrator:state';
    try {
      const raw = await this.redis.get(key);
      if (raw) {
        this.restore(JSON.parse(raw));
      }
    } catch (err) {
      this.logger.warn(`restoreFromRedis(${key}) failed: ${(err as Error).message}`);
    }
  }

  /**
   * Serialize in-memory state and write to Redis under the account-scoped key.
   */
  async persistToRedis(accountId?: string): Promise<void> {
    if (!this.redis) return;
    const key = accountId
      ? `live:orchestrator:state:${accountId}`
      : 'live:orchestrator:state';
    try {
      await this.redis.set(key, JSON.stringify(this.serialize()));
    } catch (err) {
      this.logger.warn(`persistToRedis(${key}) failed: ${(err as Error).message}`);
    }
  }

  /**
   * One-shot: if a legacy unsuffixed key exists in Redis, copy its
   * contents to the default-account suffixed key. Idempotent — does
   * nothing if the suffixed key already exists or legacy is empty.
   */
  async migrateLegacyKeyOnce(defaultAccountId: string): Promise<void> {
    if (!this.redis) return;
    const suffixed = `live:orchestrator:state:${defaultAccountId}`;
    try {
      const exists = await this.redis.get(suffixed);
      if (exists) return;
      const legacy = await this.redis.get('live:orchestrator:state');
      if (!legacy) return;
      await this.redis.set(suffixed, legacy);
      this.logger.log(`Migrated Redis key live:orchestrator:state → ${suffixed}`);
    } catch (err) {
      this.logger.warn(`migrateLegacyKeyOnce failed: ${(err as Error).message}`);
    }
  }

  /**
   * Evaluate a single M15 close. Returns a signal if a pending setup just
   * fired, or null if no entry. State is mutated to reflect the new H1
   * sweep (if any), pending expirations, cooldown updates, and sweep dedup.
   *
   * Mirrors smc-engine.ts:96-278 step-for-step but with live-aware tweaks
   * (account equity from broker, openDirections from broker, no commissionPerLot
   * since the live broker accounts for it on fills).
   */
  evaluate(
    symbol: string,
    m15Candles: BacktestCandle[],
    h1Candles: BacktestCandle[],
    d1Candles: BacktestCandle[],
    ctx: LiveContext,
    /**
     * Optional precomputed indicators. Replay passes these (parallel to
     * full-window candle arrays) to avoid recomputing on every M15 close.
     * Live leaves them undefined and we recompute fresh — cheap on the
     * small live buffers (M15=100, H1=500, D1=400 typical).
     */
    precomputed?: PrecomputedIndicators,
    /**
     * Optional "as-of" cursor. When passed, the candle arrays are treated
     * as full historical arrays and we use cursor.{m15,h1,d1} as the
     * effective length (slicing is implicit). Avoids O(n²) array.slice()
     * in replay loops. Live doesn't pass cursor — uses arr.length as-is.
     */
    cursor?: { m15: number; h1: number; d1: number },
  ): SmcLiveSignal | null {
    // Effective lengths — cursor lets replay pass full arrays + index.
    const m15Len = cursor ? cursor.m15 : m15Candles.length;
    const h1Len = cursor ? cursor.h1 : h1Candles.length;
    const d1Len = cursor ? cursor.d1 : d1Candles.length;

    if (m15Len < 30 || h1Len < 30) return null;

    const cfg = getSmcPairConfig(symbol);
    const instrumentConfig = getInstrumentConfig(symbol);
    const { pricePrecision } = instrumentConfig;
    const factor = Math.pow(10, pricePrecision);

    const state = this.getOrCreateState(symbol);
    const lastM15 = m15Candles[m15Len - 1];
    const lastClosedH1Idx = h1Len - 1;
    const lastClosedH1 = h1Candles[lastClosedH1Idx];

    // Indicator state — precomputed for replay (parallel to FULL arrays),
    // recomputed for live (small buffer). Either way `m15Len-1` is the
    // correct index for "now" because slices start at 0.
    const m15Indicators = precomputed?.m15 ?? computeIndicators(m15Candles);
    const h1Indicators = precomputed?.h1 ?? computeIndicators(h1Candles);
    const d1Indicators = precomputed
      ? precomputed.d1
      : d1Candles.length > 30
        ? computeIndicators(d1Candles)
        : null;
    // D1 bias / ADX at the current evaluation moment — computed once and
    // reused for both the sweep detection and the formatted reason string.
    const liveD1Bias: D1Bias = d1Indicators
      ? getD1Bias(d1Candles, d1Indicators, lastM15.openTime)
      : 'NEUTRAL';
    const liveD1Adx = d1Indicators
      ? d1Indicators.adx14[d1Len - 1] || 0
      : 0;

    // ─── 1. Sweep detection on each newly-closed H1 ────────────────────────
    // Live receives M15 close events. The "most recently closed" H1 might
    // already have been processed at a prior M15 close (e.g., 15:00, 15:15,
    // 15:30 all see the same 14:00–15:00 H1 bar as the last closed). We use
    // openTime to dedup processing, just like smc-engine.ts:122 uses an
    // index pointer.
    //
    // CATCH-UP: When the engine resumes after downtime (deploy / OOM /
    // weekend), `lastProcessedH1Time` may be many H1 boundaries behind the
    // current latest. We iterate forward through every unprocessed H1 bar
    // so each gets one `detectSweep` call — otherwise a sweep on a bar that
    // closed during downtime would be permanently lost.
    // 1-BAR LAG: only process H1 bars where bar N+1 has ALSO closed.
    // detectAnchorSweep's displacement check (sweep-detector.ts:269-278) requires
    // h1Candles[h1Idx + 1] to confirm a strong-bodied move in the trade direction
    // before approving a setup. In replay, h1Candles is the FULL historical array
    // and h1Idx + 1 is always accessible — replay accidentally enjoys look-ahead.
    // In live, h1Candles is the latest closed bars only; at the M15 close that
    // immediately follows a sweep H1 bar's close, the displacement bar is still
    // 0 minutes old (not closed). h1Candles[idx + 1] is undefined → nextBar=null
    // → passesDisplacement returns false → setup rejected. Then the catchup
    // marks the bar processed via state.lastProcessedH1Time so we never re-try.
    // Result: every potential sweep on the latest-just-closed H1 is silently
    // dropped in live, but caught in replay.
    //
    // Fix: define `lastUsableH1Idx = lastClosedH1Idx - 1`. We only evaluate
    // bar N once bar N+1 has also closed (one H1 later than naively possible).
    // Live can now satisfy the displacement check; replay does the exact same
    // thing → live/replay symmetry is restored. Trade entry is delayed by 1
    // H1 vs. the old (look-ahead-biased) replay timing, which is honest.
    const lastUsableH1Idx = lastClosedH1Idx - 1;
    const lastUsableH1 = lastUsableH1Idx >= 0 ? h1Candles[lastUsableH1Idx] : null;
    if (lastUsableH1 && state.lastProcessedH1Time !== lastUsableH1.openTime) {
      const firstUnprocessedIdx = state.lastProcessedH1Time
        ? this.findH1IdxAfter(h1Candles, state.lastProcessedH1Time, lastUsableH1Idx)
        : lastUsableH1Idx;

      for (let idx = firstUnprocessedIdx; idx <= lastUsableH1Idx; idx++) {
        if (liveD1Adx >= cfg.d1AdxFloor) {
          const setup = detectSweep(
            h1Candles,
            h1Indicators,
            idx,
            liveD1Bias,
            liveD1Adx,
            cfg,
            d1Candles,
            d1Indicators,
            lastM15.openTime,
          );
          if (setup && !(cfg.disabledModes ?? []).includes(setup.mode)) {
            // Skip if we've already actioned this exact H1 sweep timestamp
            // (defensive — pending queue already prevents double-take, but a
            // session restore could re-add). Use stable setup.sweepTime
            // instead of h1Candles[idx].openTime, which becomes incorrect
            // as the live H1 buffer shifts across evaluate() calls.
            if (!state.actionedSweeps.has(setup.sweepTime)) {
              state.pending.push(setup);
            }
          }
        }
      }
      state.lastProcessedH1Time = lastUsableH1.openTime;
    }

    // ─── 2. Expire stale setups ────────────────────────────────────────────
    state.pending = state.pending.filter(
      (s) => lastClosedH1Idx <= s.expiresAtH1Idx,
    );

    // ─── 3. Trade gates ────────────────────────────────────────────────────
    // Bar-count cooldown: decrement once per evaluator call (= once per M15
    // close). Mirrors V6-alt's `i + N` exactly, so weekend gaps don't erase
    // the cooldown the way wall-clock arithmetic would.
    if (state.cooldownBarsRemaining > 0) {
      state.cooldownBarsRemaining--;
      return null;
    }

    if ((cfg.newsBlackoutMinutes ?? 0) > 0) {
      const { isInBlackout } = require('../../backtest/engine/news-calendar');
      if (isInBlackout(lastM15.openTime, cfg.newsBlackoutMinutes)) return null;
    }

    // Killzone — must be inside one of the configured UTC hour ranges.
    const utcHour = new Date(lastM15.openTime).getUTCHours();
    const inZone = cfg.killzones.some(([s, e]) => utcHour >= s && utcHour < e);
    if (!inZone) return null;

    // V6-alt RiskManager gate — daily loss, consecutive losses, rolling
    // 7-day losses, equity drawdown pauses. This is the FILTER that V6-alt
    // uses to skip low-quality periods after a slump; without it, the
    // orchestrator over-trades during drawdowns.
    if (!state.riskManager.canTrade(lastM15.openTime, ctx.totalOpenPositions)) {
      return null;
    }

    // ─── 4. Try to fire a pending setup ────────────────────────────────────
    // V6-alt iterates pending in reverse (newest first) so a fresh sweep
    // takes priority over an older one nearing expiry.
    for (let s = state.pending.length - 1; s >= 0; s--) {
      const setup = state.pending[s];

      // Same-direction stacking guard — same as V6-alt and the original evaluator.
      if (ctx.openDirections.has(setup.direction)) continue;

      // Use the stable setup.sweepTime (captured at detection) instead of
      // looking up h1Candles[setup.detectedAtH1Idx].openTime — the latter
      // breaks once the live H1 buffer rolls (the index becomes stale).
      const sweepTime = setup.sweepTime;

      if (state.actionedSweeps.has(sweepTime)) {
        state.pending.splice(s, 1);
        continue;
      }

      const m15Atr = m15Indicators.atr14[m15Len - 1];
      const slBuffer =
        !isNaN(m15Atr) && m15Atr > 0
          ? m15Atr * cfg.slBufferAtrM15
          : setup.sweepCandleAtr * cfg.slBufferAtrM15;

      // Live spread comes from the broker, NOT the spread model. We use
      // the last candle's high-low range as a rough proxy when caller
      // doesn't supply a real spread; in practice live's placeOrder gets
      // a market fill so `entryPrice` is the broker fill price.
      const { getSpread } = require('../../backtest/engine/spread-model');
      const spread = getSpread(symbol, lastM15.openTime);
      const halfSpread = spread / 2;

      const entryPrice =
        setup.direction === 'BUY'
          ? lastM15.close + halfSpread
          : lastM15.close - halfSpread;

      let slPrice: number;
      if (setup.mode === 'CONTINUATION') {
        slPrice =
          setup.direction === 'BUY'
            ? setup.sweepCandleLow - slBuffer
            : setup.sweepCandleHigh + slBuffer;
      } else {
        slPrice =
          setup.direction === 'BUY'
            ? setup.sweepWick - slBuffer
            : setup.sweepWick + slBuffer;
      }

      const slPoints = Math.abs(entryPrice - slPrice);
      if (slPoints <= 0) {
        state.pending.splice(s, 1);
        continue;
      }

      // Wide-SL filter — same logic as smc-engine.ts:199.
      if ((cfg.maxSlAtrM15 ?? 0) > 0 && !isNaN(m15Atr) && m15Atr > 0) {
        if (slPoints / m15Atr > cfg.maxSlAtrM15!) {
          state.pending.splice(s, 1);
          continue;
        }
      }

      // ─── Optional SMC structure gates ─────────────────────────────
      // Each gate is enabled per-pair via SmcPairConfig flags. They run
      // AFTER the wide-SL filter (so we don't waste compute on doomed
      // setups) and BEFORE risk-sized lot calc. Pure read-only — they
      // either reject the setup or pass through.
      let gateFvg: { top: number; bottom: number; candleTime: string; isBullish: boolean } | null = null;
      let gateOb: { top: number; bottom: number; candleTime: string; isBullish: boolean } | null = null;
      let gateBos: { level: number; brokenAtTime: string } | null = null;

      if (cfg.useFvgGate) {
        const result = hasSupportingFvg(
          m15Candles,
          setup.direction,
          entryPrice,
          cfg.fvgGateMaxDistanceAtr ?? 1.5,
          m15Indicators.atr14,
          m15Len - 1,
        );
        if (!result.ok) continue;
        gateFvg = {
          top: result.fvg.top,
          bottom: result.fvg.bottom,
          candleTime: result.fvg.candleTime,
          isBullish: result.fvg.isBullish,
        };
      }

      if (cfg.useObGate) {
        const result = hasSupportingOb(
          h1Candles,
          setup.direction,
          entryPrice,
          cfg.obGateMaxDistanceAtr ?? 2.0,
          h1Indicators.atr14,
          h1Len - 1,
        );
        if (!result.ok) continue;
        gateOb = {
          top: result.ob.top,
          bottom: result.ob.bottom,
          candleTime: result.ob.candleTime,
          isBullish: result.ob.isBullish,
        };
      }

      if (cfg.useBosGate) {
        const result = hasBosAfter(
          h1Candles,
          setup.direction,
          setup.detectedAtH1Idx,
          h1Len - 1,
          cfg.bosGateSwingLookback ?? cfg.recentSwingLookbackH1,
        );
        if (!result.ok) continue;
        gateBos = { level: result.bos.level, brokenAtTime: result.bos.brokenAtTime };
      }

      // ─── Path-3 pre-sweep validity gates ──────────────────────────
      // These check the swept LEVEL was meaningful (formed by an OB,
      // an impulse FVG, or a prior BOS) — questions that ARE answerable
      // at signal time, unlike the post-entry gates above. All default
      // OFF; flipping them on is gated by the comparison-runner pass
      // criteria (see scripts/compare-smc-gates.ts).
      let gateObOrigin: { top: number; bottom: number; candleTime: string; isBullish: boolean } | null = null;
      let gateImpulseFvg: { top: number; bottom: number; candleTime: string; isBullish: boolean } | null = null;
      let gateBosOrigin: { level: number; brokenAtTime: string } | null = null;

      // Each Path-3 gate needs the H1 candle index of the swept swing,
      // not just the price. Resolve it once and share across the gates.
      let sweptSwingIdx: number | null = null;
      const needsSweptIdx =
        cfg.useObOriginGate || cfg.useImpulseFvgGate || cfg.useBosOriginGate;
      if (needsSweptIdx) {
        sweptSwingIdx = findSweptSwingIdx(
          h1Candles,
          setup.detectedAtH1Idx,
          setup.direction,
          setup.sweepLevel,
          cfg.recentSwingLookbackH1,
        );
        // If the swept swing can't be located (rare; would imply the
        // sweep detector emitted a level that doesn't match any candle
        // extreme), reject — we can't validate it either way.
        if (sweptSwingIdx == null) continue;
      }

      if (cfg.useObOriginGate && sweptSwingIdx != null) {
        const result = hasFreshObAtSweptLevel(
          h1Candles,
          sweptSwingIdx,
          setup.direction,
          cfg.obOriginLookback ?? 12,
          h1Indicators.atr14,
          cfg.obOriginDisplacementAtr ?? 1.2,
        );
        if (!result.ok) continue;
        gateObOrigin = {
          top: result.ob.top,
          bottom: result.ob.bottom,
          candleTime: result.ob.candleTime,
          isBullish: result.ob.isBullish,
        };
      }

      if (cfg.useImpulseFvgGate && sweptSwingIdx != null) {
        const result = sweptMoveLeftFvg(
          h1Candles,
          sweptSwingIdx,
          setup.direction,
          cfg.impulseFvgLookback ?? 5,
          h1Indicators.atr14,
        );
        if (!result.ok) continue;
        gateImpulseFvg = {
          top: result.fvg.top,
          bottom: result.fvg.bottom,
          candleTime: result.fvg.candleTime,
          isBullish: result.fvg.isBullish,
        };
      }

      if (cfg.useBosOriginGate && sweptSwingIdx != null) {
        const result = sweptLevelWasItselfABos(
          h1Candles,
          sweptSwingIdx,
          setup.direction,
          cfg.bosOriginLookback ?? 24,
        );
        if (!result.ok) continue;
        gateBosOrigin = {
          level: result.brokenLevel,
          brokenAtTime: result.brokenAtTime,
        };
      }

      // Risk-managed lot sizing. We synthesize an EngineConfig the same
      // way SmcLiveEvaluator did — RiskManager only reads `initialBalance`
      // and `riskPercent` for sizing math.
      const riskCfg: EngineConfig = {
        symbol,
        initialBalance: ctx.accountEquity,
        riskPercent: ctx.riskPercent ?? parseFloat(process.env.RISK_PERCENT || '1.5'),
        maxDailyLossPercent: 4.0,
        maxConsecutiveLosses: 5,
        maxOpenPositions: ctx.maxOpenPositions ?? 4,
        strategyVersion: 'SMC-V2',
      };
      const riskManager = new RiskManager(riskCfg);
      const totalLot = riskManager.calculateLotSize(
        slPoints,
        60,
        'WEAK_TREND',
        50,
        entryPrice,
      );
      const usesLadder = cfg.tp1PartialFraction > 0;
      if (usesLadder ? totalLot < 0.02 : totalLot < 0.01) continue;

      const tp2Price =
        setup.direction === 'BUY'
          ? entryPrice + slPoints * cfg.tp2R
          : entryPrice - slPoints * cfg.tp2R;

      const session = utcHour < 12 ? 'LONDON' : 'NY';
      const baseTags = ['SMC', 'SWEEP', session, setup.mode];

      const round = (n: number) => Math.round(n * factor) / factor;

      // SMC annotation context — captured here so the dashboard chart can
      // render an explainer. The H1 candle that did the sweep is at
      // `setup.detectedAtH1Idx`; we look it up to get its openTime.
      const sweepCandle = h1Candles[setup.detectedAtH1Idx];
      const smcContext = sweepCandle
        ? {
            anchorType: setup.anchorType,
            sweptLevel: setup.sweepLevel,
            sweptHigh: setup.sweepCandleHigh,
            sweptLow: setup.sweepCandleLow,
            sweepCandleTime: sweepCandle.openTime,
            d1Bias: liveD1Bias,
            // Old (failed) post-entry gate metadata — kept for backwards
            // compat with smcContext consumers
            ...(gateFvg ? { fvg: gateFvg } : {}),
            ...(gateOb ? { ob: gateOb } : {}),
            ...(gateBos ? { bos: gateBos } : {}),
            // Path-3 pre-sweep validity gate metadata
            ...(gateObOrigin ? { obOrigin: gateObOrigin } : {}),
            ...(gateImpulseFvg ? { impulseFvg: gateImpulseFvg } : {}),
            ...(gateBosOrigin ? { bosOrigin: gateBosOrigin } : {}),
          }
        : undefined;

      // Build the signal exactly like SmcLiveEvaluator did.
      let signal: SmcLiveSignal;
      if (!usesLadder) {
        signal = {
          symbol,
          side: setup.direction,
          entryPrice: round(entryPrice),
          slPrice: round(slPrice),
          tpPrice: round(tp2Price),
          totalLot,
          legs: [
            { lotSize: totalLot, tpPrice: round(tp2Price), setupTags: [...baseTags, 'RUNNER'] },
          ],
          mode: setup.mode,
          h1SweepTime: sweepTime,
          reason: this.formatReason(setup, cfg.symbol, liveD1Adx, liveD1Bias, session, false),
          smcContext,
        };
      } else {
        const tp1Lot = Math.max(0.01, Math.round(totalLot * cfg.tp1PartialFraction * 100) / 100);
        const runnerLot = Math.max(0.01, Math.round((totalLot - tp1Lot) * 100) / 100);
        if (tp1Lot < 0.01 || runnerLot < 0.01) continue;
        const tp1Price =
          setup.direction === 'BUY'
            ? entryPrice + slPoints * cfg.tp1R
            : entryPrice - slPoints * cfg.tp1R;

        signal = {
          symbol,
          side: setup.direction,
          entryPrice: round(entryPrice),
          slPrice: round(slPrice),
          tpPrice: round(tp1Price),
          totalLot,
          legs: [
            { lotSize: tp1Lot, tpPrice: round(tp1Price), setupTags: [...baseTags, 'TP1'] },
            { lotSize: runnerLot, tpPrice: round(tp2Price), setupTags: [...baseTags, 'RUNNER'] },
          ],
          mode: setup.mode,
          h1SweepTime: sweepTime,
          reason: this.formatReason(setup, cfg.symbol, liveD1Adx, liveD1Bias, session, true),
          smcContext,
        };
      }

      // DO NOT mutate state here. Splicing pending / adding actionedSweeps
      // / setting cooldown happens in recordEntry(), which the caller calls
      // ONLY after at least one broker order leg actually succeeded. If
      // placeOrder fails for all legs, recordEntry is NOT called and the
      // setup stays in pending → next M15 close will retry. Pending expiry
      // (cfg.setupExpiryH1Bars) bounds the retry window naturally.
      //
      // Replay (SimulatedBroker always succeeds) calls recordEntry
      // unconditionally — same outcome as the old in-evaluate mutations.

      return signal;
    }

    return null;
  }

  /**
   * Commit a fired signal: remove the corresponding setup from pending,
   * mark its sweepTime as actioned to prevent re-firing, and apply the
   * post-trade 1-bar cooldown.
   *
   * Caller contract: MUST be called AFTER at least one broker order leg
   * has actually been placed (and persisted to the DB). In live, that
   * means LiveStrategyService.placeOrder confirmed `successfulLegs > 0`.
   * In replay, SimulatedBroker always succeeds so this is unconditional.
   *
   * If placeOrder fails entirely (broker rejection on every leg, DB write
   * failure, etc.), the caller must NOT call this — leaving the setup in
   * pending so the next M15 close re-tries. The orchestrator's expiry
   * filter (cfg.setupExpiryH1Bars) bounds the retry window.
   *
   * Before this refactor the state mutations were baked into evaluate()
   * itself, so a failed broker order silently consumed the sweep — see
   * the 'Bug A' analysis on PR #31.
   */
  recordEntry(symbol: string, signal: SmcLiveSignal): void {
    const state = this.getOrCreateState(symbol);
    state.pending = state.pending.filter((p) => p.sweepTime !== signal.h1SweepTime);
    state.actionedSweeps.add(signal.h1SweepTime);
    state.cooldownBarsRemaining = 1;
  }

  /**
   * Apply SL/TP cooldown after a position closes. Caller is the position
   * monitor service which knows the exit reason. ALSO records the trade
   * with the RiskManager so consecutive-losses and daily-PnL counters
   * track properly — this is what gates over-trading during slumps.
   *
   * `slCooldownBars` from cfg is in M15 bars; we convert to wall-clock minutes.
   */
  recordExit(
    symbol: string,
    exitReason: 'SL' | 'TP' | 'OTHER',
    exitTimeIso: string,
    pnl?: number,
  ): void {
    const state = this.getOrCreateState(symbol);
    const cfg = getSmcPairConfig(symbol);
    let bars: number;
    if (exitReason === 'TP') bars = 2;
    else if (exitReason === 'SL') bars = cfg.slCooldownBars;
    else bars = 1;
    state.cooldownBarsRemaining = Math.max(state.cooldownBarsRemaining, bars);

    // Tell RiskManager — populates dailyPnl, consecutiveLosses, etc. so
    // canTrade() can pause on slumps.
    if (typeof pnl === 'number') {
      const reasonForRm =
        exitReason === 'SL' ? 'SL'
        : exitReason === 'TP' ? 'TP'
        : 'FORCED_CLOSE';
      state.riskManager.recordTrade(pnl, exitTimeIso, reasonForRm);
    }
  }

  /**
   * Read-only snapshot of per-pair orchestrator state for the dashboard
   * "Engine Worker" telemetry view. No effect on live state. Returns
   * one entry per pair the orchestrator has seen — empty if the engine
   * hasn't received its first M15 close yet.
   */
  getTelemetry(): Record<string, OrchestratorTelemetry> {
    const out: Record<string, OrchestratorTelemetry> = {};
    for (const [sym, s] of this.states.entries()) {
      out[sym] = {
        pendingCount: s.pending.length,
        lastProcessedH1Time: s.lastProcessedH1Time,
        cooldownBarsRemaining: s.cooldownBarsRemaining,
        pending: s.pending.map((p) => ({
          direction: p.direction,
          mode: p.mode,
          entryHint: p.sweepMid,
          detectedAtH1Idx: p.detectedAtH1Idx,
          expiresAtH1Idx: p.expiresAtH1Idx,
        })),
      };
    }
    return out;
  }

  // ─── internals ────────────────────────────────────────────────────────

  /**
   * Locate the first H1 index whose openTime is strictly AFTER the supplied
   * `afterIso`, capped at `maxIdx`. Used by the catch-up loop to resume
   * sweep detection from the bar immediately following the last one we
   * processed. Falls back to maxIdx when the previously-processed bar can't
   * be located (e.g. it dropped off the rolling buffer between restarts) —
   * a single-bar process is still better than infinite-loop-or-nothing.
   */
  private findH1IdxAfter(
    h1Candles: BacktestCandle[],
    afterIso: string,
    maxIdx: number,
  ): number {
    const afterMs = new Date(afterIso).getTime();
    for (let i = 0; i <= maxIdx; i++) {
      if (new Date(h1Candles[i].openTime).getTime() > afterMs) return i;
    }
    return maxIdx; // fall back: only process the latest
  }

  private getOrCreateState(symbol: string): OrchestratorState {
    let s = this.states.get(symbol);
    if (!s) {
      s = {
        pending: [],
        lastProcessedH1Time: null,
        cooldownBarsRemaining: 0,
        actionedSweeps: new Set(),
        riskManager: this.buildRiskManager(symbol),
      };
      this.states.set(symbol, s);
    }
    return s;
  }

  private buildRiskManager(symbol: string): RiskManager {
    return new RiskManager({
      symbol,
      initialBalance: this.defaultRiskCfg.initialBalance,
      riskPercent: this.defaultRiskCfg.riskPercent,
      maxDailyLossPercent: 4.0,
      maxConsecutiveLosses: 5,
      maxOpenPositions: this.defaultRiskCfg.maxOpenPositions,
      strategyVersion: 'SMC-V2',
    });
  }

  private formatReason(
    setup: PendingSetup,
    symbol: string,
    d1Adx: number,
    d1Bias: D1Bias,
    session: string,
    ladder: boolean,
  ): string {
    const tail = ladder ? ', ladder' : '';
    return `${setup.mode} ${setup.direction} on ${symbol} — D1 ADX=${d1Adx.toFixed(1)}, bias=${d1Bias}, ${session}${tail}`;
  }

  // For tests / introspection
  getState(symbol: string): OrchestratorState | undefined {
    return this.states.get(symbol);
  }
}
