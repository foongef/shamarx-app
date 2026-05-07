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
import { Injectable, Logger } from '@nestjs/common';
import { computeIndicators } from '../../backtest/engine/indicator-calculator';
import { getInstrumentConfig } from '../../backtest/engine/instrument-config';
import { RiskManager } from '../../backtest/engine/risk-manager';
import { getSmcPairConfig } from '../../backtest/engine/smc/pairs';
import { detectSweep } from '../../backtest/engine/smc/sweep-detector';
import { getD1Bias } from '../../backtest/engine/strategy-evaluator';
import { BacktestCandle, D1Bias, EngineConfig } from '../../backtest/engine/types';
import { PendingSetup, SmcMode } from '../../backtest/engine/smc/types';
import { SmcLiveSignal } from './smc-live-evaluator';

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
  private readonly logger = new Logger(LiveSmcOrchestrator.name);
  private readonly states = new Map<string, OrchestratorState>();

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

  /** Snapshot — for Redis persistence. RiskManager state is reconstructed
   *  on restore by replaying recent closed trades; we don't try to serialize
   *  its internals (consecutiveLosses, paused-until-date, etc.) since the
   *  position-monitor recordExit will re-establish them on the next M15. */
  serialize(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [sym, s] of this.states.entries()) {
      out[sym] = {
        pending: s.pending,
        lastProcessedH1Time: s.lastProcessedH1Time,
        cooldownBarsRemaining: s.cooldownBarsRemaining,
        actionedSweeps: Array.from(s.actionedSweeps),
      };
    }
    return out;
  }

  restore(snapshot: Record<string, any>): void {
    this.states.clear();
    for (const [sym, raw] of Object.entries(snapshot ?? {})) {
      this.states.set(sym, {
        pending: raw.pending ?? [],
        lastProcessedH1Time: raw.lastProcessedH1Time ?? null,
        // Migrate legacy snapshots: if we see the old wall-clock field,
        // reset the bar counter (better than incorrectly translating times).
        cooldownBarsRemaining: typeof raw.cooldownBarsRemaining === 'number' ? raw.cooldownBarsRemaining : 0,
        actionedSweeps: new Set(raw.actionedSweeps ?? []),
        riskManager: this.buildRiskManager(sym),
      });
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
  ): SmcLiveSignal | null {
    if (m15Candles.length < 30 || h1Candles.length < 30) return null;

    const cfg = getSmcPairConfig(symbol);
    const instrumentConfig = getInstrumentConfig(symbol);
    const { pricePrecision } = instrumentConfig;
    const factor = Math.pow(10, pricePrecision);

    const state = this.getOrCreateState(symbol);
    const lastM15 = m15Candles[m15Candles.length - 1];
    const lastClosedH1Idx = h1Candles.length - 1;
    const lastClosedH1 = h1Candles[lastClosedH1Idx];

    const m15Indicators = computeIndicators(m15Candles);
    const h1Indicators = computeIndicators(h1Candles);
    const d1Indicators = d1Candles.length > 30 ? computeIndicators(d1Candles) : null;
    // D1 bias / ADX at the current evaluation moment — computed once and
    // reused for both the sweep detection and the formatted reason string.
    const liveD1Bias: D1Bias = d1Indicators
      ? getD1Bias(d1Candles, d1Indicators, lastM15.openTime)
      : 'NEUTRAL';
    const liveD1Adx = d1Indicators
      ? d1Indicators.adx14[d1Candles.length - 1] || 0
      : 0;

    // ─── 1. Sweep detection on each newly-closed H1 ────────────────────────
    // Live receives M15 close events. The "most recently closed" H1 might
    // already have been processed at a prior M15 close (e.g., 15:00, 15:15,
    // 15:30 all see the same 14:00–15:00 H1 bar as the last closed). We use
    // openTime to dedup processing, just like smc-engine.ts:122 uses an
    // index pointer.
    if (
      lastClosedH1 &&
      state.lastProcessedH1Time !== lastClosedH1.openTime
    ) {
      if (liveD1Adx >= cfg.d1AdxFloor) {
        const setup = detectSweep(
          h1Candles,
          h1Indicators,
          lastClosedH1Idx,
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
          // session restore could re-add).
          const sweepTime = h1Candles[setup.detectedAtH1Idx].openTime;
          if (!state.actionedSweeps.has(sweepTime)) {
            state.pending.push(setup);
          }
        }
      }
      state.lastProcessedH1Time = lastClosedH1.openTime;
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

      const sweepTime = h1Candles[setup.detectedAtH1Idx]?.openTime ?? '';

      // Defensive — shouldn't happen since we filter pendings above, but
      // sweepTime can be missing if the H1 buffer rotated past the index.
      if (!sweepTime) {
        state.pending.splice(s, 1);
        continue;
      }

      if (state.actionedSweeps.has(sweepTime)) {
        state.pending.splice(s, 1);
        continue;
      }

      const m15Atr = m15Indicators.atr14[m15Candles.length - 1];
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
        strategyVersion: 'V6-alt',
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
        };
      }

      // Mark consumed → remove from queue, dedup, set 1-bar cooldown
      // (matches V6-alt's `cooldownUntil = i + 1; break;` after entry).
      state.pending.splice(s, 1);
      state.actionedSweeps.add(sweepTime);
      state.cooldownBarsRemaining = 1;

      return signal;
    }

    return null;
  }

  /**
   * Apply post-trade cooldown — call AFTER the order is actually placed
   * (so we don't punish ourselves for skipped/rejected setups).
   *
   * V6-alt uses bar-index arithmetic; live uses time arithmetic.
   * SL/TP cooldowns are applied by `recordExit()` when positions close.
   */
  recordEntry(symbol: string, _signal: SmcLiveSignal): void {
    const state = this.getOrCreateState(symbol);
    // Cooldown was already set to next M15 inside evaluate(); recordEntry
    // is reserved for any future bookkeeping (e.g. quality scoring).
    void state; // touch
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

  // ─── internals ────────────────────────────────────────────────────────

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
      strategyVersion: 'V6-alt',
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
