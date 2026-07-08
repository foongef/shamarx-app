/**
 * SimulatedBroker — in-memory broker for live-replay backtests.
 *
 * Holds the shared simulated account across all 4 pairs. Each leg of an
 * SmcLiveSignal opens a separate position (mirroring live's placeOrder
 * loop in live-strategy.service.ts:246).
 *
 * Fill model:
 *   - Position opens at signal.entryPrice the moment the signal fires
 *     (idealized; live has slippage we don't model).
 *   - Each subsequent M15 candle: V6-alt's `updatePositionManagement`
 *     runs first (BE move + trail), THEN SL/TP hit checks.
 *   - SL takes priority on ambiguous bars (worst-case fill convention,
 *     matches V6-alt).
 *
 * PnL formula matches src/backtest/engine/position-simulator.ts:264:
 *   priceDiff = (exitPrice - entryPrice) * (BUY:+1, SELL:-1)
 *   rawPnl    = priceDiff * lotSize * lotSizeUnits
 *   if JPY-quote: rawPnl /= exitPrice
 */

import { SmcLiveSignal } from '../../strategy/live/smc-live-evaluator';
import {
  BacktestCandle,
  SimulatedPosition as V6SimulatedPosition,
} from '../engine/types';
import { getInstrumentConfig } from '../engine/instrument-config';
import { getSpread } from '../engine/spread-model';
import { updatePositionManagement } from '../engine/position-simulator';
import { SMC_TP1_TRAIL, SMC_RUNNER_TRAIL } from '../engine/smc/trail-config';
import { RegimeTradeParams } from '../engine/types';
import { randomUUID } from 'crypto';

/**
 * Live-replay extends V6-alt's SimulatedPosition with id/symbol/mode/reason
 * fields needed to persist DB rows. Inheritance lets us pass instances
 * straight to V6-alt's `updatePositionManagement` without conversion.
 */
export interface SimulatedPosition extends V6SimulatedPosition {
  id: string;
  symbol: string;
  openedAt: string;     // duplicates entryTime for clarity in DB rows
  mode: 'REVERSAL' | 'CONTINUATION';
  reason: string;
  /** SMC annotation context captured at signal-fire — survives into the
   *  ClosedPosition and ultimately the LiveReplayTrade DB row so the
   *  chart expander can render the swept level + sweep candle range. */
  sweptLevel?: number;
  sweptHigh?: number;
  sweptLow?: number;
  sweepCandleTime?: string;
  d1Bias?: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
}

export interface ClosedPosition extends SimulatedPosition {
  closePrice: number;
  closedAt: string;
  pnl: number;
  exitReason: 'SL' | 'TP' | 'FORCED_CLOSE';
}

/** Retrace-entry experiment: instead of filling at the signal's market
 *  price, park a limit `frac` of the entry→SL distance back toward the
 *  sweep and wait up to `expiryBars` M15 bars for a touch. Risk per lot
 *  shrinks to (1-frac)×original, so legs are rescaled ×1/(1-frac) at fill
 *  to keep dollar risk identical to baseline — the A/B then compares
 *  entry QUALITY, not accidental position-size differences. */
export interface RetraceEntryCfg {
  frac: number;        // 0.3 = limit 30% back toward SL
  expiryBars: number;  // cancel unfilled after N M15 bars
}

interface PendingLimit {
  signal: SmcLiveSignal;
  limitPrice: number;
  scale: number;       // leg lot multiplier (1/(1-frac))
  barsLeft: number;
}

export class SimulatedBroker {
  private balance: number;
  private positions = new Map<string, SimulatedPosition[]>();
  private closed: ClosedPosition[] = [];
  private maxConcurrent = 0;
  private pendingLimits = new Map<string, PendingLimit[]>();

  /** Experiment-only override for the RUNNER leg's trail parameters —
   *  merged over SMC_RUNNER_TRAIL. Live trading never passes this. */
  private readonly runnerTrail: RegimeTradeParams;
  private readonly retraceEntry?: RetraceEntryCfg;

  constructor(
    initialBalance: number,
    runnerTrailOverride?: Partial<RegimeTradeParams>,
    retraceEntry?: RetraceEntryCfg,
  ) {
    this.balance = initialBalance;
    this.runnerTrail = { ...SMC_RUNNER_TRAIL, ...(runnerTrailOverride ?? {}) };
    this.retraceEntry = retraceEntry;
  }

  /** Pending limit orders awaiting a retrace touch (experiment mode). */
  pendingCount(): number {
    let n = 0;
    for (const list of this.pendingLimits.values()) n += list.length;
    return n;
  }

  /**
   * Check open positions for `symbol` against the candle.
   * Order matches V6-alt's smc-engine.ts:101-118:
   *   1. Update trade management (BE move + trail) using candle high/low.
   *   2. Check SL/TP hit against the (possibly updated) SL/TP.
   *   3. Close on hit; SL takes priority on ambiguous bars.
   */
  processCandle(symbol: string, candle: BacktestCandle): ClosedPosition[] {
    this.processPendingLimits(symbol, candle);
    const open = this.positions.get(symbol) ?? [];
    if (open.length === 0) return [];

    const spread = getSpread(symbol, candle.openTime);

    // Step 1: BE + trail. Each call returns either the same position
    // (no change) or a new one with updated SL/peak/breakevenActivated/tpPrice.
    // Positions FILLED on this very bar (retrace limits) are excluded:
    // the bar's high may have printed BEFORE the fill, so crediting it to
    // the peak (or allowing a same-bar TP) would be look-ahead. Same-bar
    // STOP-OUT remains allowed — pessimism cuts one way only.
    const managed = open.map((p) => {
      if (p.entryTime === candle.openTime) return p;
      const updated = updatePositionManagement(p, candle, spread);
      // updatePositionManagement returns V6SimulatedPosition; we need to
      // re-attach our extension fields when it returns a NEW object.
      return updated === p
        ? p
        : ({
            ...updated,
            id: p.id,
            symbol: p.symbol,
            openedAt: p.openedAt,
            mode: p.mode,
            reason: p.reason,
            sweptLevel: p.sweptLevel,
            sweptHigh: p.sweptHigh,
            sweptLow: p.sweptLow,
            sweepCandleTime: p.sweepCandleTime,
            d1Bias: p.d1Bias,
          } as SimulatedPosition);
    });
    this.positions.set(symbol, managed);

    const stillOpen: SimulatedPosition[] = [];
    const justClosed: ClosedPosition[] = [];

    for (const pos of managed) {
      const slHit = pos.side === 'BUY'
        ? candle.low <= pos.slPrice
        : candle.high >= pos.slPrice;
      // tpPrice is nullable — V6-alt removes it once price travels far
      // enough (tpRemovalR), letting the runner go on trail only.
      const tpHit = pos.entryTime !== candle.openTime && pos.tpPrice !== null && (
        pos.side === 'BUY'
          ? candle.high >= pos.tpPrice
          : candle.low <= pos.tpPrice
      );

      if (slHit) {
        const closed = this.close(pos, pos.slPrice, candle.openTime, 'SL');
        justClosed.push(closed);
      } else if (tpHit) {
        const closed = this.close(pos, pos.tpPrice as number, candle.openTime, 'TP');
        justClosed.push(closed);
      } else {
        stillOpen.push(pos);
      }
    }

    if (stillOpen.length === 0) {
      this.positions.delete(symbol);
    } else {
      this.positions.set(symbol, stillOpen);
    }
    return justClosed;
  }

  /**
   * Open a position per leg. Returns the new positions (caller persists to DB).
   * Each leg gets its own trailConfig — TP1 leg uses SMC_TP1_TRAIL, runner
   * uses SMC_RUNNER_TRAIL — same per-leg config V6-alt assigns.
   */
  placeOrder(signal: SmcLiveSignal, openTime: string): SimulatedPosition[] {
    if (this.retraceEntry) {
      const { frac, expiryBars } = this.retraceEntry;
      const dist = Math.abs(signal.entryPrice - signal.slPrice);
      const limitPrice = signal.side === 'BUY'
        ? signal.entryPrice - dist * frac
        : signal.entryPrice + dist * frac;
      const list = this.pendingLimits.get(signal.symbol) ?? [];
      list.push({
        signal,
        limitPrice,
        scale: 1 / (1 - frac),
        barsLeft: expiryBars,
      });
      this.pendingLimits.set(signal.symbol, list);
      return []; // engine treats a parked limit as setup-consumed
    }
    return this.fillAt(signal, signal.entryPrice, openTime, 1);
  }

  /** Fill/expire parked limits against this bar. Fills happen BEFORE the
   *  caller's SL/TP pass, so a bar that sweeps through the limit AND the
   *  stop produces a same-bar loss — the pessimistic assumption. */
  private processPendingLimits(symbol: string, candle: BacktestCandle): void {
    const list = this.pendingLimits.get(symbol);
    if (!list || list.length === 0) return;
    const remaining: PendingLimit[] = [];
    for (const p of list) {
      const touched = p.signal.side === 'BUY'
        ? candle.low <= p.limitPrice
        : candle.high >= p.limitPrice;
      if (touched) {
        this.fillAt(p.signal, p.limitPrice, candle.openTime, p.scale);
        continue;
      }
      p.barsLeft -= 1;
      if (p.barsLeft > 0) remaining.push(p);
      // else: expired unfilled — the strong reversal left without us
    }
    if (remaining.length > 0) this.pendingLimits.set(symbol, remaining);
    else this.pendingLimits.delete(symbol);
  }

  private fillAt(
    signal: SmcLiveSignal,
    entryPrice: number,
    openTime: string,
    lotScale: number,
  ): SimulatedPosition[] {
    const opened: SimulatedPosition[] = [];
    const list = this.positions.get(signal.symbol) ?? [];

    for (const leg of signal.legs) {
      const isTp1Leg = leg.setupTags.includes('TP1');
      const trail = isTp1Leg ? SMC_TP1_TRAIL : this.runnerTrail;

      const pos: SimulatedPosition = {
        id: randomUUID(),
        symbol: signal.symbol,
        side: signal.side,
        lotSize: Math.round(leg.lotSize * lotScale * 100) / 100,
        entryPrice,
        slPrice: signal.slPrice,
        originalSlPrice: signal.slPrice,
        tpPrice: leg.tpPrice,
        openedAt: openTime,
        entryTime: openTime,
        entryIndex: 0, // not used by trade management
        setupTags: leg.setupTags,
        h1Bias: signal.side === 'BUY' ? 'BULLISH' : 'BEARISH',
        rsiAtEntry: 50,
        atrAtEntry: 0,
        breakevenActivated: false,
        peakFavorablePrice: entryPrice,
        trailConfig: trail,
        regimeAtEntry: 'WEAK_TREND',
        mode: signal.mode,
        reason: signal.reason,
        sweptLevel: signal.smcContext?.sweptLevel,
        sweptHigh: signal.smcContext?.sweptHigh,
        sweptLow: signal.smcContext?.sweptLow,
        sweepCandleTime: signal.smcContext?.sweepCandleTime,
        d1Bias: signal.smcContext?.d1Bias,
      };
      list.push(pos);
      opened.push(pos);
    }
    this.positions.set(signal.symbol, list);
    this.maxConcurrent = Math.max(this.maxConcurrent, this.totalOpenCount());
    return opened;
  }

  /**
   * Close any remaining open positions for `symbol` at `closePrice`. Used
   * at end-of-replay to flush dangling positions for final accounting.
   */
  closeAllForSymbol(symbol: string, closePrice: number, closeTime: string): ClosedPosition[] {
    const open = this.positions.get(symbol) ?? [];
    const result: ClosedPosition[] = [];
    for (const pos of open) {
      result.push(this.close(pos, closePrice, closeTime, 'FORCED_CLOSE'));
    }
    this.positions.delete(symbol);
    return result;
  }

  /** Open BUY/SELL directions for the given symbol. */
  getOpenDirections(symbol: string): Set<'BUY' | 'SELL'> {
    const set = new Set<'BUY' | 'SELL'>();
    for (const p of this.positions.get(symbol) ?? []) set.add(p.side);
    return set;
  }

  /** Total count across all symbols — used to enforce maxOpenPositions. */
  totalOpenCount(): number {
    let n = 0;
    for (const list of this.positions.values()) n += list.length;
    return n;
  }

  getBalance(): number {
    return this.balance;
  }

  /** For now equity == balance; we don't mark-to-market unrealized PnL. */
  getEquity(): number {
    return this.balance;
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  getClosed(): ClosedPosition[] {
    return this.closed;
  }

  // ─── internals ────────────────────────────────────────────────────────

  private close(
    pos: SimulatedPosition,
    closePrice: number,
    closeTime: string,
    exitReason: ClosedPosition['exitReason'],
  ): ClosedPosition {
    const pnl = this.calcPnl(pos, closePrice);
    this.balance += pnl;
    const closed: ClosedPosition = {
      ...pos,
      closePrice,
      closedAt: closeTime,
      pnl,
      exitReason,
    };
    this.closed.push(closed);
    return closed;
  }

  private calcPnl(pos: SimulatedPosition, closePrice: number): number {
    const cfg = getInstrumentConfig(pos.symbol);
    const direction = pos.side === 'BUY' ? 1 : -1;
    const priceDiff = (closePrice - pos.entryPrice) * direction;
    let raw = priceDiff * pos.lotSize * cfg.lotSizeUnits;
    if (pos.symbol.endsWith('JPY')) raw /= closePrice;
    return Math.round(raw * 100) / 100;
  }
}
