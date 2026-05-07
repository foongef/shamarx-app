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
 *   - Each subsequent M15 candle is checked: if low <= SL (BUY) or high >=
 *     TP (BUY), position closes at SL/TP price respectively. SELL is the
 *     mirror. If both touched in the same bar, we close at SL (worst-case
 *     for the trader — same convention as the legacy backtest).
 *
 * PnL formula matches src/backtest/engine/position-simulator.ts:264:
 *   priceDiff = (exitPrice - entryPrice) * (BUY:+1, SELL:-1)
 *   rawPnl    = priceDiff * lotSize * lotSizeUnits
 *   if JPY-quote: rawPnl /= exitPrice
 */

import { SmcLiveSignal } from '../../strategy/live/smc-live-evaluator';
import { BacktestCandle } from '../engine/types';
import { getInstrumentConfig } from '../engine/instrument-config';
import { randomUUID } from 'crypto';

export interface SimulatedPosition {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  lotSize: number;
  entryPrice: number;
  slPrice: number;
  tpPrice: number;
  openedAt: string;
  setupTags: string[];
  mode: 'REVERSAL' | 'CONTINUATION';
  reason: string;
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
   * Check open positions for `symbol` against the candle. Closes any that
   * hit SL/TP, updates balance, returns the list of closed positions.
   */
  processCandle(symbol: string, candle: BacktestCandle): ClosedPosition[] {
    const open = this.positions.get(symbol) ?? [];
    if (open.length === 0) return [];

    const stillOpen: SimulatedPosition[] = [];
    const justClosed: ClosedPosition[] = [];

    for (const pos of open) {
      const slHit = pos.side === 'BUY'
        ? candle.low <= pos.slPrice
        : candle.high >= pos.slPrice;
      const tpHit = pos.side === 'BUY'
        ? candle.high >= pos.tpPrice
        : candle.low <= pos.tpPrice;

      if (slHit) {
        // SL takes priority on ambiguous bars (worst-case fill convention).
        const closed = this.close(pos, pos.slPrice, candle.openTime, 'SL');
        justClosed.push(closed);
      } else if (tpHit) {
        const closed = this.close(pos, pos.tpPrice, candle.openTime, 'TP');
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
   */
  placeOrder(signal: SmcLiveSignal, openTime: string): SimulatedPosition[] {
    const opened: SimulatedPosition[] = [];
    const list = this.positions.get(signal.symbol) ?? [];
    for (const leg of signal.legs) {
      const pos: SimulatedPosition = {
        id: randomUUID(),
        symbol: signal.symbol,
        side: signal.side,
        lotSize: leg.lotSize,
        entryPrice: signal.entryPrice,
        slPrice: signal.slPrice,
        tpPrice: leg.tpPrice,
        openedAt: openTime,
        setupTags: leg.setupTags,
        mode: signal.mode,
        reason: signal.reason,
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

  /** Open BUY/SELL directions for the given symbol — feeds LiveEvaluationContext. */
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
