/**
 * Live-replay engine — drives the LiveSmcOrchestrator across all 4 pairs
 * on one shared simulated account.
 *
 * Compared to the legacy V6-alt per-pair backtest, this engine replicates:
 *   - Multi-bar pending-setup queue (a sweep stays valid for
 *     cfg.setupExpiryH1Bars; any M15 in that window can take it)
 *   - Cooldown after entry (1 bar) and after exit (TP=2 bars, SL=cfg.slCooldownBars)
 *   - Trade management (BE move + trail) via V6-alt's updatePositionManagement
 *
 * Plus live-realistic dynamics that V6-alt's per-pair backtest misses:
 *   - Cross-pair shared equity (lot sizing reflects portfolio drawdown)
 *   - Cross-pair maxOpenPositions cap
 *   - Same-direction stacking guard reads broker open positions
 */

import { Logger } from '@nestjs/common';
import { LiveSmcOrchestrator, PrecomputedIndicators } from '../../strategy/live/live-smc-orchestrator';
import { BacktestCandle } from '../engine/types';
import { computeIndicators } from '../engine/indicator-calculator';
import { SimulatedBroker, ClosedPosition, SimulatedPosition } from './simulated-broker';

export interface ReplayConfig {
  startDate: string;        // ISO yyyy-mm-dd
  endDate: string;          // ISO yyyy-mm-dd
  initialBalance: number;
  riskPercent: number;
  pairs: string[];
  /** Hard cap on simultaneous open positions across all pairs. Default 4. */
  maxOpenPositions?: number;
}

/** Optional progress reporter — called every YIELD_EVERY events. Worker uses
 *  this to forward 'progress' messages to the parent without crossing the
 *  thread boundary on every iteration. */
export type ProgressFn = (processed: number, total: number) => void;

/** Loaded candle bundle keyed by symbol → timeframe. */
export type CandleBundle = Record<string, {
  m15: BacktestCandle[];
  h1: BacktestCandle[];
  d1: BacktestCandle[];
}>;

export interface ReplayResult {
  opened: SimulatedPosition[];
  closed: ClosedPosition[];
  finalBalance: number;
  maxConcurrent: number;
  metrics: {
    tradesCount: number;
    winsCount: number;
    lossesCount: number;
    realizedPnl: number;
    netReturnPct: number;
  };
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Yield to the event loop every N timeline events so a long replay (2y × 4 pairs
// ≈ 280k iterations) does not block NestJS for the whole run. Without this,
// /api/strategy/health stops responding mid-replay and nginx upstream errors
// out — the API looks "down" until the replay finishes.
const YIELD_EVERY = 250;
const yieldToEventLoop = () => new Promise<void>((r) => setImmediate(r));

export class ReplayEngine {
  private readonly logger = new Logger(ReplayEngine.name);

  /**
   * Pass a fresh orchestrator per replay run; state must not leak across
   * runs (per-pair pendings/cooldown reset between sessions).
   */
  constructor(private readonly orchestrator: LiveSmcOrchestrator) {}

  async run(
    cfg: ReplayConfig,
    candles: CandleBundle,
    onProgress?: ProgressFn,
  ): Promise<ReplayResult> {
    // Always start with a clean orchestrator state.
    this.orchestrator.resetAll();
    // Seed the per-pair RiskManager constructors with our test parameters
    // so canTrade() uses the correct daily-loss / consecutive-loss thresholds.
    this.orchestrator.setDefaultRiskCfg({
      initialBalance: cfg.initialBalance,
      riskPercent: cfg.riskPercent,
      maxOpenPositions: cfg.maxOpenPositions ?? 4,
    });

    const broker = new SimulatedBroker(cfg.initialBalance);
    const startMs = new Date(cfg.startDate).getTime();
    const endMs = new Date(cfg.endDate).getTime();
    const maxOpenPositions = cfg.maxOpenPositions ?? 4;

    // Precompute indicators ONCE per pair over the full window. The
    // orchestrator then reads `arr[cursor-1]` without recomputing — drops
    // total replay work from O(n²) to O(n). Same numerical result as
    // recomputing per-call because indicator values are deterministic
    // given the candle prefix.
    const t0 = Date.now();
    const indicators: Record<string, PrecomputedIndicators> = {};
    for (const sym of cfg.pairs) {
      const b = candles[sym];
      if (!b) continue;
      indicators[sym] = {
        m15: computeIndicators(b.m15),
        h1: computeIndicators(b.h1),
        d1: b.d1.length > 30 ? computeIndicators(b.d1) : null,
      };
    }
    this.logger.log(
      `Precomputed indicators for ${cfg.pairs.length} pairs in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );

    const timeline = this.buildTimeline(candles, startMs, endMs);
    this.logger.log(
      `Replay timeline: ${timeline.length} M15 events across ${cfg.pairs.length} pairs`,
    );

    // Per-symbol cursors avoid re-scanning candle arrays each step. Each
    // points at the first index NOT yet visible to the evaluator at the
    // current timestep.
    const cursors: Record<string, { m15: number; h1: number; d1: number }> = {};
    for (const sym of cfg.pairs) cursors[sym] = { m15: 0, h1: 0, d1: 0 };

    const opened: SimulatedPosition[] = [];
    const closed: ClosedPosition[] = [];

    let i = 0;
    const total = timeline.length;
    for (const ev of timeline) {
      if (i++ % YIELD_EVERY === 0 && i > 1) {
        await yieldToEventLoop();
        onProgress?.(i, total);
      }
      const { symbol, candle } = ev;
      const bundle = candles[symbol];
      if (!bundle) continue;

      // 1. Advance cursors to include all candles with openTime <= current
      //    M15 candle. M15 cursor lands at i+1 (current candle now visible).
      //    H1/D1 advance to bars whose CLOSE was at-or-before the current
      //    timestamp (openTime + tf duration <= now+1ms).
      const cur = cursors[symbol];
      const evMs = new Date(candle.openTime).getTime();
      while (cur.m15 < bundle.m15.length &&
             new Date(bundle.m15[cur.m15].openTime).getTime() <= evMs) {
        cur.m15++;
      }
      while (cur.h1 < bundle.h1.length &&
             new Date(bundle.h1[cur.h1].openTime).getTime() + HOUR_MS <= evMs + 1) {
        cur.h1++;
      }
      while (cur.d1 < bundle.d1.length &&
             new Date(bundle.d1[cur.d1].openTime).getTime() + DAY_MS <= evMs + 1) {
        cur.d1++;
      }

      // 2. Process exits — broker checks SL/TP against the new bar's high/low
      //    AFTER applying BE/trail. Returns the closed positions for this bar.
      const exits = broker.processCandle(symbol, candle);
      for (const exit of exits) {
        closed.push(exit);
        // Tell the orchestrator about the exit so it can apply cooldowns
        // AND record the PnL with its RiskManager (drives consecutive-loss
        // pauses, daily-loss caps, drawdown brakes).
        this.orchestrator.recordExit(
          symbol,
          exit.exitReason === 'SL' ? 'SL' : exit.exitReason === 'TP' ? 'TP' : 'OTHER',
          exit.closedAt,
          exit.pnl,
        );
      }

      // Need at least 30 M15 + 30 H1 for the orchestrator to do anything.
      if (cur.m15 < 30 || cur.h1 < 30) continue;

      // 3. Call the orchestrator with FULL candle arrays + cursor — no
      //    array slicing per call (was O(n²)). Same numerical result as
      //    passing slices because all downstream logic is index-based.
      const signal = this.orchestrator.evaluate(
        symbol,
        bundle.m15,
        bundle.h1,
        bundle.d1,
        {
          accountEquity: broker.getEquity(),
          openDirections: broker.getOpenDirections(symbol),
          totalOpenPositions: broker.totalOpenCount(),
          riskPercent: cfg.riskPercent,
          nowIso: candle.openTime,
          maxOpenPositions,
        },
        indicators[symbol],
        cur,
      );
      if (!signal) continue;

      // 4. Place order via simulated broker — opens 1 position per leg.
      const positions = broker.placeOrder(signal, candle.openTime);
      opened.push(...positions);
      this.orchestrator.recordEntry(symbol, signal);

      this.logger.debug(
        `[${symbol} ${candle.openTime}] ${signal.mode} ${signal.side} ${signal.totalLot}lot — ${signal.reason}`,
      );
    }

    // Force-close any positions still open at end of replay window using
    // the LAST candle's close, so the metrics include realized PnL for
    // every position the strategy entered.
    for (const sym of cfg.pairs) {
      const last = candles[sym]?.m15[candles[sym].m15.length - 1];
      if (!last) continue;
      const flushed = broker.closeAllForSymbol(sym, last.close, last.openTime);
      closed.push(...flushed);
    }

    const closedAll = broker.getClosed();
    const wins = closedAll.filter((t) => (t.pnl ?? 0) > 0).length;
    const losses = closedAll.filter((t) => (t.pnl ?? 0) <= 0).length;
    const realizedPnl = closedAll.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const finalBalance = broker.getBalance();

    return {
      opened,
      closed,
      finalBalance,
      maxConcurrent: broker.getMaxConcurrent(),
      metrics: {
        tradesCount: closedAll.length,
        winsCount: wins,
        lossesCount: losses,
        realizedPnl: Math.round(realizedPnl * 100) / 100,
        netReturnPct: cfg.initialBalance > 0
          ? Math.round((realizedPnl / cfg.initialBalance) * 10000) / 100
          : 0,
      },
    };
  }

  private buildTimeline(
    candles: CandleBundle,
    startMs: number,
    endMs: number,
  ): Array<{ symbol: string; candle: BacktestCandle }> {
    const out: Array<{ symbol: string; candle: BacktestCandle; ts: number }> = [];
    for (const [symbol, bundle] of Object.entries(candles)) {
      for (const c of bundle.m15) {
        const ts = new Date(c.openTime).getTime();
        if (ts < startMs || ts > endMs) continue;
        out.push({ symbol, candle: c, ts });
      }
    }
    out.sort((a, b) => a.ts - b.ts);
    return out.map(({ symbol, candle }) => ({ symbol, candle }));
  }
}
