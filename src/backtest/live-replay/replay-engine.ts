/**
 * Live-replay engine — drives SmcLiveEvaluator across all 4 pairs on one
 * shared simulated account, mirroring live's portfolio dynamics.
 *
 * Why this exists (vs the legacy V6-alt backtest): the strategy code path is
 * already shared (live's evaluator calls the same detectSweep + getD1Bias
 * primitives V6-alt uses), but V6-alt runs each pair in isolation with its
 * own equity. This engine interleaves all 4 pairs on a unified timeline so
 * cross-pair effects (openDirections ctx, equity-driven lot sizing,
 * maxOpenPositions) are exercised the same way live does.
 */

import { Logger } from '@nestjs/common';
import { SmcLiveEvaluator } from '../../strategy/live/smc-live-evaluator';
import { BacktestCandle } from '../engine/types';
import { SimulatedBroker, ClosedPosition, SimulatedPosition } from './simulated-broker';

export interface ReplayConfig {
  startDate: string;        // ISO yyyy-mm-dd
  endDate: string;          // ISO yyyy-mm-dd
  initialBalance: number;
  riskPercent: number;
  pairs: string[];          // e.g. ["XAUUSD","EURUSD","GBPUSD","USDJPY"]
}

/** Loaded candle bundle keyed by symbol → timeframe. */
export type CandleBundle = Record<string, {
  m15: BacktestCandle[];
  h1: BacktestCandle[];
  d1: BacktestCandle[];
}>;

export interface ReplayResult {
  opened: SimulatedPosition[];   // mirrors trade-row inserts
  closed: ClosedPosition[];      // exits — trade-row updates
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

export class ReplayEngine {
  private readonly logger = new Logger(ReplayEngine.name);

  constructor(private readonly evaluator: SmcLiveEvaluator) {}

  /**
   * Run the replay. Caller is responsible for loading `candles` (M15/H1/D1
   * for each pair, including 90-day pre-roll for HTF indicator stability).
   *
   * Returns the full opened + closed position lists so the caller can
   * persist them in one batch.
   */
  run(cfg: ReplayConfig, candles: CandleBundle): ReplayResult {
    const broker = new SimulatedBroker(cfg.initialBalance);
    const startMs = new Date(cfg.startDate).getTime();
    const endMs = new Date(cfg.endDate).getTime();

    // Build the unified timeline: every M15 candle from any pair, sorted by
    // openTime. This lets us interleave evaluation across pairs the same way
    // live does (each M15 close fires an evaluation for that pair only).
    const timeline = this.buildTimeline(candles, startMs, endMs);
    this.logger.log(
      `Replay timeline: ${timeline.length} M15 events across ${cfg.pairs.length} pairs`,
    );

    // Per-symbol cursor into m15/h1/d1 arrays — avoids re-scanning each step.
    // Each cursor points at the first index NOT yet visible to the evaluator
    // at the current timestep, so the slice [0..cursor) is the rolling
    // history available.
    const cursors: Record<string, { m15: number; h1: number; d1: number }> = {};
    for (const sym of cfg.pairs) cursors[sym] = { m15: 0, h1: 0, d1: 0 };

    // Per-pair sweep dedup — mirrors live's `actionedSweeps` map at
    // live-strategy.service.ts:101 so we don't re-enter on the same H1 sweep.
    const actionedSweeps: Record<string, Set<string>> = {};
    for (const sym of cfg.pairs) actionedSweeps[sym] = new Set();

    const opened: SimulatedPosition[] = [];
    const closed: ClosedPosition[] = [];

    for (const ev of timeline) {
      const { symbol, candle } = ev;
      const bundle = candles[symbol];
      if (!bundle) continue;

      // 1. Advance cursors to include all candles with openTime <= this M15
      //    candle's openTime. M15 cursor lands at i+1 (this candle is now
      //    visible to the evaluator); H1/D1 advance to all bars that closed
      //    by this timestamp. Critical: no lookahead — strategy only sees
      //    bars whose openTime <= current candle's openTime.
      const cur = cursors[symbol];
      const evMs = new Date(candle.openTime).getTime();

      while (cur.m15 < bundle.m15.length &&
             new Date(bundle.m15[cur.m15].openTime).getTime() <= evMs) {
        cur.m15++;
      }
      while (cur.h1 < bundle.h1.length &&
             new Date(bundle.h1[cur.h1].openTime).getTime() + HOUR_MS <= evMs + 1) {
        // include H1 bar if it has CLOSED by evMs (i.e. openTime + 1h <= evMs).
        cur.h1++;
      }
      while (cur.d1 < bundle.d1.length &&
             new Date(bundle.d1[cur.d1].openTime).getTime() + DAY_MS <= evMs + 1) {
        cur.d1++;
      }

      // 2. Process exits first — check open positions for this symbol against
      //    the current candle's high/low.
      const exits = broker.processCandle(symbol, candle);
      closed.push(...exits);

      // 3. Build LiveEvaluationContext from broker state. Critical: equity
      //    and openDirections are SHARED across all pairs (this is what the
      //    legacy V6-alt backtest can't model).
      const ctx = {
        accountEquity: broker.getEquity(),
        openDirections: broker.getOpenDirections(symbol),
        recentlyEnteredSweepTimes: actionedSweeps[symbol],
      };

      const m15Slice = bundle.m15.slice(0, cur.m15);
      const h1Slice = bundle.h1.slice(0, cur.h1);
      const d1Slice = bundle.d1.slice(0, cur.d1);

      // Need at least 30 M15 + 30 H1 for the evaluator to do anything.
      if (m15Slice.length < 30 || h1Slice.length < 30) continue;

      // 4. Call the live evaluator. Same code path live uses on every M15 close.
      const signal = this.evaluator.evaluate(
        symbol,
        m15Slice,
        h1Slice,
        d1Slice,
        ctx,
        cfg.riskPercent,
      );
      if (!signal) continue;

      // 5. Place order via simulated broker — opens 1 position per leg.
      const positions = broker.placeOrder(signal, candle.openTime);
      opened.push(...positions);
      actionedSweeps[symbol].add(signal.h1SweepTime);

      this.logger.debug(
        `[${symbol} ${candle.openTime}] ${signal.mode} ${signal.side} ${signal.totalLot}lot — ${signal.reason}`,
      );
    }

    // Flush any positions still open at the end of the replay window. Use
    // the LAST candle's close as the exit — this mirrors how a paper-trading
    // session handles end-of-test cleanup for accounting purposes.
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
        // Only events INSIDE the replay window get evaluated; the warm-up
        // pre-roll candles are still loaded so cursor advancement gives the
        // evaluator enough HTF history at start.
        if (ts < startMs || ts > endMs) continue;
        out.push({ symbol, candle: c, ts });
      }
    }
    out.sort((a, b) => a.ts - b.ts);
    return out.map(({ symbol, candle }) => ({ symbol, candle }));
  }
}
