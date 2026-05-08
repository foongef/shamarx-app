/**
 * LIVE strategy service — runs V6-alt SMC evaluation on each M15 candle close
 * and places orders via execution-service.
 *
 * Activates ONLY when LIVE_MODE=true. The legacy BOS evaluator in
 * `strategy.service.ts` continues to exist (not invoked) for backward compat.
 */
import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { randomUUID } from 'crypto';
import { PrismaService } from '@app/prisma';
import { RedisService, REDIS_CHANNELS } from '@app/redis';
import { Timeframe, SERVICE_URLS, CandleDto } from '@app/common';
import {
  SmcLiveEvaluator,
  SmcLiveSignal,
  LiveEvaluationContext,
} from './smc-live-evaluator';
import { LiveSmcOrchestrator } from './live-smc-orchestrator';
import { LiveControlService } from './live-control.service';
import { BacktestCandle } from '../../backtest/engine/types';

const M15_BUFFER = 100;
const H1_BUFFER = 500;
const D1_BUFFER = 400;
const ORCHESTRATOR_STATE_KEY = 'live:orchestrator:state';

const TELEMETRY_RING_SIZE = 200;

/** Debounce window for orchestrator-state persistence. 4 pairs evaluating at
 *  the same M15 boundary mark dirty within ~50ms of each other; coalescing
 *  them into one Redis write keeps the write rate at ~16/hour instead of ~64. */
const PERSIST_DEBOUNCE_MS = 500;

/** Periodic safety-net interval. Catches mutations that don't go through
 *  evaluatePair() (e.g. position-monitor's recordExit when broker closes a
 *  position) without coupling those callers to the persistence path. Worst-
 *  case state-loss window on a hard crash = this value. */
const PERSIST_INTERVAL_MS = 30_000;

/** Telemetry event captured for the dashboard's Engine Worker view.
 *  Stored in an in-memory ring buffer — not persisted, lost on restart.
 *  Persistence isn't worth the write traffic; the dashboard is fine
 *  with "since last restart" history. */
export type TelemetryEvent =
  | { ts: string; symbol: string; type: 'eval'; decision: 'no-sweep' | 'pending-only' | 'cooldown' }
  | { ts: string; symbol: string; type: 'sweep-detected'; direction: 'BUY' | 'SELL'; mode: string; entryHint: number }
  | { ts: string; symbol: string; type: 'signal-fired'; side: 'BUY' | 'SELL'; mode: string; entryPrice: number };

@Injectable()
export class LiveStrategyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LiveStrategyService.name);
  private readonly liveMode: boolean;
  private readonly pairs: string[];
  private readonly evaluator: SmcLiveEvaluator;
  private subscribed = false;

  /** Sweep timestamps already actioned this session per symbol — prevents double-entry */
  private actionedSweeps = new Map<string, Set<string>>();

  /** Ring buffer of recent telemetry events for the dashboard Engine Worker view.
   *  Capped at TELEMETRY_RING_SIZE to keep memory bounded; oldest events drop. */
  private events: TelemetryEvent[] = [];

  /** Per-pair last-evaluation snapshot — small map, dashboard reads this for
   *  the pair scanner strip's "X seconds ago" badges. */
  private lastEval = new Map<string, { ts: string; decision: 'no-sweep' | 'pending-only' | 'cooldown' }>();

  /** UTC-day-keyed counters. Reset lazily on the first event of a new day. */
  private counters = { date: '', evals: 0, sweeps: 0, signals: 0 };

  // ─── Persistence scheduler ────────────────────────────────────────────
  // Pattern:
  //   - markPersistDirty(): dirty flag + 500ms debounce → coalesces bursts
  //   - PERSIST_INTERVAL_MS interval: backstop, catches mutations from
  //     anywhere (e.g. position-monitor.recordExit) without the caller
  //     having to know about persistence
  //   - flushOrchestratorState(): idempotent, in-flight guarded, retries
  //     on failure (re-marks dirty)
  //   - onModuleDestroy: clears timers + final await flush

  private persistDirty = false;
  private persistDebounceTimer: NodeJS.Timeout | null = null;
  private persistIntervalTimer: NodeJS.Timeout | null = null;
  private persistInFlight = false;

  private markPersistDirty(): void {
    this.persistDirty = true;
    if (this.persistDebounceTimer) return;
    this.persistDebounceTimer = setTimeout(() => {
      this.persistDebounceTimer = null;
      this.flushOrchestratorState().catch(() => { /* logged inside */ });
    }, PERSIST_DEBOUNCE_MS);
  }

  private async flushOrchestratorState(): Promise<void> {
    if (!this.persistDirty || this.persistInFlight) return;
    this.persistInFlight = true;
    this.persistDirty = false; // optimistic — re-marked on failure
    try {
      const snapshot = this.orchestrator.serialize();
      await this.redis.set(ORCHESTRATOR_STATE_KEY, JSON.stringify(snapshot));
    } catch (err) {
      // Re-mark so the next debounce / interval / shutdown retries the write.
      // We never lose a mutation — at worst we're delayed by the interval.
      this.persistDirty = true;
      this.logger.warn(`Could not persist orchestrator state: ${(err as Error).message}`);
    } finally {
      this.persistInFlight = false;
    }
  }

  private pushEvent(ev: TelemetryEvent) {
    // Roll counters at UTC midnight — not exact but close enough for a UI badge.
    const today = ev.ts.slice(0, 10);
    if (this.counters.date !== today) {
      this.counters = { date: today, evals: 0, sweeps: 0, signals: 0 };
    }
    if (ev.type === 'eval') {
      this.counters.evals++;
      this.lastEval.set(ev.symbol, { ts: ev.ts, decision: ev.decision });
    } else if (ev.type === 'sweep-detected') {
      this.counters.sweeps++;
    } else if (ev.type === 'signal-fired') {
      this.counters.signals++;
    }
    this.events.push(ev);
    if (this.events.length > TELEMETRY_RING_SIZE) {
      this.events.splice(0, this.events.length - TELEMETRY_RING_SIZE);
    }
  }

  /** Public-facing minimal pulse for the marketing landing page. Does NOT
   *  expose entry hints, event detail, or position data — safe for
   *  unauthenticated readers. Only enough to drive the visible "engine is
   *  alive" animations: per-pair lastEvalAt + lastDecision + UTC counters. */
  getPublicPulse() {
    const pairs: Record<string, { lastEvalAt: string | null; lastDecision: string }> = {};
    for (const sym of this.pairs) {
      const e = this.lastEval.get(sym);
      pairs[sym] = {
        lastEvalAt: e?.ts ?? null,
        lastDecision: e?.decision ?? 'unknown',
      };
    }
    return {
      serverNowIso: new Date().toISOString(),
      pairs,
      counters: {
        evalsToday: this.counters.evals,
        sweepsToday: this.counters.sweeps,
        signalsToday: this.counters.signals,
      },
      isRunning: this.liveControl.isRunning(),
    };
  }

  /** Read-only snapshot for the dashboard Engine Worker view. Combines
   *  in-memory ring buffer + per-pair last-eval + orchestrator pending state.
   *  Live trading not affected — pure read. */
  getTelemetry() {
    const now = new Date().toISOString();
    const orchestratorState = this.orchestrator.getTelemetry();

    const pairs: Record<string, {
      lastEvalAt: string | null;
      lastDecision: string;
      cooldownBarsRemaining: number;
      pendingCount: number;
      pending: Array<{
        direction: 'BUY' | 'SELL';
        mode: string;
        entryHint: number;
        detectedAtH1Idx: number;
        expiresAtH1Idx: number;
      }>;
    }> = {};

    for (const sym of this.pairs) {
      const e = this.lastEval.get(sym);
      const o = orchestratorState[sym];
      pairs[sym] = {
        lastEvalAt: e?.ts ?? null,
        lastDecision: e?.decision ?? 'unknown',
        cooldownBarsRemaining: o?.cooldownBarsRemaining ?? 0,
        pendingCount: o?.pendingCount ?? 0,
        pending: o?.pending ?? [],
      };
    }

    // Cap recent events to last 50 — the full ring buffer is bigger but the
    // UI only needs the visible window.
    const recentEvents = this.events.slice(-50).reverse();

    return {
      serverNowIso: now,
      pairs,
      counters: {
        date: this.counters.date,
        evalsToday: this.counters.evals,
        sweepsToday: this.counters.sweeps,
        signalsToday: this.counters.signals,
      },
      recentEvents,
      isRunning: this.liveControl.isRunning(),
    };
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly httpService: HttpService,
    private readonly config: ConfigService,
    private readonly liveControl: LiveControlService,
    private readonly orchestrator: LiveSmcOrchestrator,
  ) {
    this.liveMode = (this.config.get<string>('LIVE_MODE') || 'false').toLowerCase() === 'true';
    const pairsCsv = this.config.get<string>('STRATEGY_PAIRS') || 'XAUUSD,EURUSD,GBPUSD,USDJPY';
    this.pairs = pairsCsv.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    this.evaluator = new SmcLiveEvaluator();
  }

  async onModuleInit() {
    if (!this.liveMode) {
      this.logger.log('LIVE_MODE=false — live strategy is DORMANT (legacy BOS service still bound)');
      return;
    }
    this.logger.log(`LIVE_MODE=true — SMC-V2 live trading enabled for ${this.pairs.join(', ')}`);
    for (const pair of this.pairs) this.actionedSweeps.set(pair, new Set());

    // Restore orchestrator state from Redis so a container restart mid-day
    // doesn't drop the pending-sweeps queue or cooldown timers.
    try {
      const raw = await this.redis.get(ORCHESTRATOR_STATE_KEY);
      if (raw) {
        this.orchestrator.restore(JSON.parse(raw));
        this.logger.log('Restored orchestrator state from Redis');
      }
    } catch (err) {
      this.logger.warn(`Could not restore orchestrator state: ${(err as Error).message}`);
    }

    await this.redis.subscribe(REDIS_CHANNELS.CANDLE_STORED, (message) => {
      try {
        const data = JSON.parse(message);
        if (data.timeframe !== Timeframe.M15) return;
        const symbol = (data.symbol || '').toUpperCase();
        if (!this.pairs.includes(symbol)) return;
        // Runtime gate: skip evaluation when the engine is "paused" via the
        // dashboard Start/Stop button, even when LIVE_MODE=true.
        if (!this.liveControl.isRunning()) return;
        this.evaluatePair(symbol).catch((err) =>
          this.logger.error(`Live eval failed for ${symbol}: ${err.message}`, err.stack),
        );
      } catch (err) {
        this.logger.warn(`Bad CANDLE_STORED payload: ${(err as Error).message}`);
      }
    });
    this.subscribed = true;

    // Backstop persistence interval — flushes any state mutated outside
    // evaluatePair() (most importantly position-monitor.recordExit when the
    // broker closes a position) within PERSIST_INTERVAL_MS of the change.
    // No-ops when nothing is dirty.
    this.persistIntervalTimer = setInterval(() => {
      this.flushOrchestratorState().catch(() => { /* logged inside */ });
    }, PERSIST_INTERVAL_MS);
  }

  async onModuleDestroy() {
    // RedisService manages its own subscription lifecycle.
    this.subscribed = false;

    // Tear down the persistence scheduler. Cancel any pending debounce so it
    // doesn't fire after we've already flushed; cancel the periodic timer;
    // then do a final synchronous flush so a clean shutdown never loses the
    // most recent mutations. A hard crash (SIGKILL, OOM) skips this path —
    // worst case = up to PERSIST_INTERVAL_MS of state lost.
    if (this.persistDebounceTimer) {
      clearTimeout(this.persistDebounceTimer);
      this.persistDebounceTimer = null;
    }
    if (this.persistIntervalTimer) {
      clearInterval(this.persistIntervalTimer);
      this.persistIntervalTimer = null;
    }
    await this.flushOrchestratorState();
  }

  /**
   * Public entrypoint for manual / scheduled triggers (e.g. from controllers).
   *
   * Routes through `LiveSmcOrchestrator` which mirrors V6-alt's per-pair
   * backtest logic: a sweep stays in a pending queue across multiple M15
   * bars (so we can take it on bar 14:15, 14:30, 14:45 if 14:00 fails some
   * gate), with post-trade cooldowns. The legacy stateless `SmcLiveEvaluator`
   * is kept as a primitive — used by the orchestrator's internals.
   */
  async evaluatePair(symbol: string): Promise<SmcLiveSignal | null> {
    const [m15, h1, d1, openPositions, allOpenPositions, account] = await Promise.all([
      this.fetchCandles(symbol, Timeframe.M15, M15_BUFFER),
      this.fetchCandles(symbol, Timeframe.H1, H1_BUFFER),
      this.fetchCandles(symbol, Timeframe.D1, D1_BUFFER),
      this.fetchOpenPositions(symbol),
      this.fetchAllOpenPositions(),
      this.fetchAccount(),
    ]);

    const evalTs = m15[m15.length - 1]?.openTime ?? new Date().toISOString();

    // Snapshot pending count BEFORE evaluate() so we can detect new sweeps
    // by comparing pre/post counts. The orchestrator may have added a sweep
    // to the pending queue inside evaluate(), even when no signal fires.
    const pendingBefore = this.orchestrator.getTelemetry()[symbol]?.pendingCount ?? 0;

    const signal = this.orchestrator.evaluate(symbol, m15, h1, d1, {
      accountEquity: account.equity,
      openDirections: new Set(openPositions.map((p) => p.side as 'BUY' | 'SELL')),
      totalOpenPositions: allOpenPositions.length,
      riskPercent: this.liveControl.getRiskPercent(),
      nowIso: evalTs,
      maxOpenPositions: 4,
    });

    const post = this.orchestrator.getTelemetry()[symbol];
    const pendingAfter = post?.pendingCount ?? 0;

    // Emit a sweep-detected event when the pending queue grew this call.
    // Use the most recent pending entry — buildTelemetry guarantees order.
    if (pendingAfter > pendingBefore) {
      const fresh = post!.pending[post!.pending.length - 1];
      this.pushEvent({
        ts: evalTs,
        symbol,
        type: 'sweep-detected',
        direction: fresh.direction,
        mode: fresh.mode,
        entryHint: fresh.entryHint,
      });
    }

    if (!signal) {
      this.logger.debug(`[${symbol}] no signal`);
      this.pushEvent({
        ts: evalTs,
        symbol,
        type: 'eval',
        decision:
          (post?.cooldownBarsRemaining ?? 0) > 0
            ? 'cooldown'
            : pendingAfter > 0
              ? 'pending-only'
              : 'no-sweep',
      });
      // Even no-signal evaluations mutate state (cooldown decrement, sweep
      // dedup, pending expiry). Mark dirty so the snapshot stays fresh.
      this.markPersistDirty();
      return null;
    }

    this.logger.log(`[${symbol}] signal → ${signal.reason}`);
    this.pushEvent({
      ts: evalTs,
      symbol,
      type: 'signal-fired',
      side: signal.side,
      mode: signal.mode,
      entryPrice: signal.entryPrice,
    });
    await this.placeOrder(signal);
    this.orchestrator.recordEntry(symbol, signal);
    // Signal-fire is the most important state mutation — actionedSweeps,
    // cooldown, RiskManager all updated. Mark dirty (debounced flush within
    // PERSIST_DEBOUNCE_MS). The 4-pair burst at any M15 boundary will
    // collapse to one Redis write.
    this.markPersistDirty();
    return signal;
  }

  /**
   * Synthetic test trade — bypasses the SMC evaluator. Used for verifying
   * end-to-end execution path (broker connection, order placement, DB
   * persistence, position-monitor reconciliation).
   *
   * Places a small lot (default 0.01) at the latest candle close with tight
   * SL/TP derived from M15 ATR. Goes through the SAME placeOrder() code path
   * as a real signal, so a successful test trade implies the entire chain
   * works.
   */
  async fireTestTrade(opts: {
    symbol: string;
    side?: 'BUY' | 'SELL';
    lotSize?: number;
    slAtrMult?: number;
    tpRMult?: number;
  }): Promise<SmcLiveSignal> {
    const symbol = opts.symbol.toUpperCase();
    const side: 'BUY' | 'SELL' = opts.side ?? 'BUY';
    const lotSize = opts.lotSize ?? 0.01;
    const slAtrMult = opts.slAtrMult ?? 1.0;
    const tpRMult = opts.tpRMult ?? 2.0;

    if (!this.liveControl.isRunning()) {
      throw new Error('Engine is not running. Start a session first.');
    }
    if (!this.pairs.includes(symbol)) {
      throw new Error(`Pair ${symbol} not in STRATEGY_PAIRS=${this.pairs.join(',')}`);
    }

    const m15 = await this.fetchCandles(symbol, Timeframe.M15, 50);
    if (m15.length < 20) throw new Error(`Not enough M15 candles for ${symbol} to compute ATR`);

    const last = m15[m15.length - 1];
    const entryPrice = last.close;

    // Crude ATR over last 14 bars
    const atr14 = m15.slice(-14).reduce((sum, c, i, arr) => {
      if (i === 0) return sum;
      const tr = Math.max(
        c.high - c.low,
        Math.abs(c.high - arr[i - 1].close),
        Math.abs(c.low - arr[i - 1].close),
      );
      return sum + tr;
    }, 0) / 13;

    const slDistance = atr14 * slAtrMult;
    const slPrice =
      side === 'BUY' ? entryPrice - slDistance : entryPrice + slDistance;
    const tpPrice =
      side === 'BUY' ? entryPrice + slDistance * tpRMult : entryPrice - slDistance * tpRMult;

    const round = (n: number) => {
      // gold pricePrecision=2, JPY=3, others=5
      const decimals = symbol === 'XAUUSD' ? 2 : symbol.endsWith('JPY') ? 3 : 5;
      const factor = Math.pow(10, decimals);
      return Math.round(n * factor) / factor;
    };

    const signal: SmcLiveSignal = {
      symbol,
      side,
      entryPrice: round(entryPrice),
      slPrice: round(slPrice),
      tpPrice: round(tpPrice),
      totalLot: lotSize,
      legs: [
        {
          lotSize,
          tpPrice: round(tpPrice),
          setupTags: ['TEST', 'MANUAL', side],
        },
      ],
      mode: 'REVERSAL',
      h1SweepTime: new Date().toISOString(),
      reason: `TEST trade: ${side} ${symbol} ${lotSize} lot @ ${round(entryPrice)} SL=${round(slPrice)} TP=${round(tpPrice)} (ATR=${atr14.toFixed(5)} × ${slAtrMult})`,
    };

    this.logger.warn(`[TEST-TRADE] firing → ${signal.reason}`);
    await this.placeOrder(signal);
    return signal;
  }

  private async fetchCandles(
    symbol: string,
    timeframe: string,
    count: number,
  ): Promise<BacktestCandle[]> {
    const url = `${SERVICE_URLS.EXECUTION}/candles`;
    const res = await firstValueFrom(
      this.httpService.get<CandleDto[]>(url, { params: { symbol, timeframe, count } }),
    );
    return (res.data || []).map((c) => ({
      symbol,
      timeframe,
      openTime: c.openTime,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));
  }

  private async fetchOpenPositions(
    symbol: string,
  ): Promise<Array<{ ticket: number; side: string; lotSize: number; entryPrice: number; sl: number; tp: number; pnl: number }>> {
    const url = `${SERVICE_URLS.EXECUTION}/positions`;
    const res = await firstValueFrom(
      this.httpService.get(url, { params: { symbol } }),
    );
    return res.data || [];
  }

  /**
   * All open positions across the account — used by the orchestrator to
   * enforce a portfolio-wide `maxOpenPositions` cap (matches V6-alt's
   * RiskManager.canTrade which we don't yet wire into live).
   */
  private async fetchAllOpenPositions(): Promise<Array<{ ticket: number; symbol: string; side: string }>> {
    const url = `${SERVICE_URLS.EXECUTION}/positions`;
    const res = await firstValueFrom(this.httpService.get(url));
    return res.data || [];
  }

  /**
   * Retry wrapper for broker order placement — MetaAPI occasionally
   * returns transient 5xx or websocket-disconnected errors. We retry up
   * to 2 times with linear backoff before giving up; permanent errors
   * (4xx like insufficient margin) bubble up immediately.
   */
  private async postOrderWithRetry(body: Record<string, unknown>): Promise<{ data: any }> {
    const MAX_ATTEMPTS = 3;
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await firstValueFrom(
          this.httpService.post(`${SERVICE_URLS.EXECUTION}/orders`, body),
        );
      } catch (err) {
        lastErr = err;
        const status = (err as any)?.response?.status as number | undefined;
        // Don't retry permanent failures — bad request, insufficient margin, etc.
        if (status && status >= 400 && status < 500) throw err;
        if (attempt < MAX_ATTEMPTS) {
          const delay = attempt * 500;
          this.logger.warn(`order placement attempt ${attempt} failed (${(err as Error).message}); retrying in ${delay}ms`);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    throw lastErr;
  }

  private async fetchAccount(): Promise<{ balance: number; equity: number }> {
    const url = `${SERVICE_URLS.EXECUTION}/account`;
    const res = await firstValueFrom(this.httpService.get(url));
    return res.data;
  }

  private async placeOrder(signal: SmcLiveSignal): Promise<void> {
    const slPoints = Math.abs(signal.entryPrice - signal.slPrice);
    // Slippage guardrail: live broker fills can drift from the intended
    // entry. If the actual fill price differs from `signal.entryPrice` by
    // more than 30% of the SL distance, the trade's risk-reward is
    // distorted enough that the backtest signal no longer applies — we
    // immediately close that leg. 30% mirrors V6-alt's tolerance for
    // out-of-band executions implicit in its commission model.
    const MAX_SLIPPAGE_FRACTION = 0.30;

    // Each leg becomes a separate broker order.
    for (const leg of signal.legs) {
      const clientOrderId = randomUUID();
      // Idempotency: refuse if a Trade with this clientOrderId already exists.
      // (Belt-and-braces; uuid collision is astronomically unlikely.)
      const dupe = await this.prisma.trade.findUnique({ where: { clientOrderId } });
      if (dupe) continue;

      try {
        const res = await this.postOrderWithRetry({
          symbol: signal.symbol,
          side: signal.side,
          lotSize: leg.lotSize,
          entryPrice: signal.entryPrice,
          slPrice: signal.slPrice,
          tpPrice: leg.tpPrice,
          comment: `SMC:${clientOrderId.slice(0, 8)}`,
        });
        const order = res.data;

        const fillPrice = typeof order.entryPrice === 'number' && order.entryPrice > 0
          ? order.entryPrice
          : signal.entryPrice;
        const slippage = Math.abs(fillPrice - signal.entryPrice);
        const slippageFrac = slPoints > 0 ? slippage / slPoints : 0;
        if (slippageFrac > MAX_SLIPPAGE_FRACTION) {
          this.logger.warn(
            `[${signal.symbol}] excessive slippage ${(slippageFrac * 100).toFixed(1)}% — closing ticket=${order.mt5Ticket} immediately`,
          );
          if (order.mt5Ticket) {
            try {
              await firstValueFrom(
                this.httpService.post(`${SERVICE_URLS.EXECUTION}/positions/${order.mt5Ticket}/close`, {}),
              );
            } catch (closeErr) {
              this.logger.error(`emergency close failed ticket=${order.mt5Ticket}: ${(closeErr as Error).message}`);
            }
          }
          continue;
        }

        // Persist a CandidateTrade + Trade so dashboard + journal pick it up.
        const candidate = await this.prisma.candidateTrade.create({
          data: {
            symbol: signal.symbol,
            side: signal.side,
            entryPrice: signal.entryPrice,
            slPrice: signal.slPrice,
            tpPrice: leg.tpPrice,
            slPoints: Math.abs(signal.entryPrice - signal.slPrice),
            tpPoints: Math.abs(leg.tpPrice - signal.entryPrice),
            setupTags: leg.setupTags,
            h1Bias: signal.side === 'BUY' ? 'BULLISH' : 'BEARISH',
            rsiValue: 0,
            atrValue: 0,
            spreadAtDetection: 0,
            timeframe: 'M15',
            status: 'APPROVED',
          },
        });

        const trailKey: 'TP1' | 'RUNNER' = leg.setupTags.includes('TP1') ? 'TP1' : 'RUNNER';
        await this.prisma.trade.create({
          data: {
            candidateId: candidate.id,
            clientOrderId,
            mt5Ticket: order.mt5Ticket ?? null,
            sessionId: this.liveControl.getCurrentSessionId(),
            symbol: signal.symbol,
            side: signal.side,
            lotSize: leg.lotSize,
            entryPrice: signal.entryPrice,
            slPrice: signal.slPrice,
            tpPrice: leg.tpPrice,
            status: 'OPEN',
            statusHistory: [
              { status: 'PENDING', timestamp: new Date().toISOString() },
              { status: 'OPEN', timestamp: new Date().toISOString(), ticket: order.mt5Ticket },
            ],
            // Seed trade-management state so LivePositionManagerService has
            // what it needs on the next M15 close (BE flag, original SL,
            // peak price, trail-config selector).
            managementState: {
              breakevenActivated: false,
              peakFavorablePrice: signal.entryPrice,
              originalSlPrice: signal.slPrice,
              trailKey,
            } as any,
          },
        });

        await this.redis.publish(REDIS_CHANNELS.TRADE_OPENED, {
          candidateId: candidate.id,
          clientOrderId,
          symbol: signal.symbol,
          side: signal.side,
          lotSize: leg.lotSize,
          entryPrice: signal.entryPrice,
          mt5Ticket: order.mt5Ticket,
        });

        this.logger.log(
          `[${signal.symbol}] OPENED ${signal.side} ${leg.lotSize} lot @${signal.entryPrice} SL=${signal.slPrice} TP=${leg.tpPrice} ticket=${order.mt5Ticket}`,
        );
      } catch (err) {
        const msg = (err as Error).message;
        this.logger.error(`[${signal.symbol}] order failed for leg ${JSON.stringify(leg)}: ${msg}`);
      }
    }
  }
}
