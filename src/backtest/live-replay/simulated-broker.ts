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

export class SimulatedBroker {
  private balance: number;
  private positions = new Map<string, SimulatedPosition[]>();
  private closed: ClosedPosition[] = [];
  private maxConcurrent = 0;

  constructor(initialBalance: number) {
    this.balance = initialBalance;
  }

  /**
   * Check open positions for `symbol` against the candle.
   * Order matches V6-alt's smc-engine.ts:101-118:
   *   1. Update trade management (BE move + trail) using candle high/low.
   *   2. Check SL/TP hit against the (possibly updated) SL/TP.
   *   3. Close on hit; SL takes priority on ambiguous bars.
   */
  processCandle(symbol: string, candle: BacktestCandle): ClosedPosition[] {
    const open = this.positions.get(symbol) ?? [];
    if (open.length === 0) return [];

    const spread = getSpread(symbol, candle.openTime);

    // Step 1: BE + trail. Each call returns either the same position
    // (no change) or a new one with updated SL/peak/breakevenActivated/tpPrice.
    const managed = open.map((p) => {
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
      const tpHit = pos.tpPrice !== null && (
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
    const opened: SimulatedPosition[] = [];
    const list = this.positions.get(signal.symbol) ?? [];

    for (const leg of signal.legs) {
      const isTp1Leg = leg.setupTags.includes('TP1');
      const trail = isTp1Leg ? SMC_TP1_TRAIL : SMC_RUNNER_TRAIL;

      const pos: SimulatedPosition = {
        id: randomUUID(),
        symbol: signal.symbol,
        side: signal.side,
        lotSize: leg.lotSize,
        entryPrice: signal.entryPrice,
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
        peakFavorablePrice: signal.entryPrice,
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
