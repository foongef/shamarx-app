import { BacktestCandle, SimulatedPosition, ClosedTrade } from './types';

/**
 * Update trade management:
 * 1. Track peak favorable price (best bid for BUY, best ask for SELL)
 * 2. At 1R favorable: activate breakeven (move SL to entry)
 * 3. After breakeven: trail SL at (peak - 1R), locking in profit as price extends
 *
 * The trailing stop is mathematically >= the fixed breakeven stop:
 * - At peak = 1R: trail SL = entry (same as BE)
 * - At peak > 1R: trail SL > entry (captures partial profit)
 * - TP still triggers normally, so TP winners are unaffected
 *
 * Returns a new position object (does not mutate).
 */
export function updatePositionManagement(
  position: SimulatedPosition,
  candle: BacktestCandle,
  spread: number,
): SimulatedPosition {
  const risk = Math.abs(position.entryPrice - position.originalSlPrice);
  // V2.7: Unified BE at 1.0R for all trades (SCALP mode removed)
  const breakevenThreshold = risk;

  let updatedPeak = position.peakFavorablePrice;
  let newSlPrice = position.slPrice;
  let newBreakeven = position.breakevenActivated;

  if (position.side === 'BUY') {
    // Track peak bid price
    const halfSpread = spread / 2;
    const currentBid = candle.high - halfSpread;
    if (currentBid > updatedPeak) {
      updatedPeak = currentBid;
    }

    // Check breakeven activation
    if (!newBreakeven && updatedPeak >= position.entryPrice + breakevenThreshold) {
      newBreakeven = true;
      // V2.7: Micro-profit BE at entry + 0.15R (covers commission)
      newSlPrice = position.entryPrice + risk * 0.15;
    }

    // V2.7: Trailing stop for all trades
    if (newBreakeven) {
      const favorableMove = updatedPeak - position.entryPrice;
      const trailDistance = favorableMove >= risk * 1.5 ? risk * 0.75 : risk;
      const trailSl = updatedPeak - trailDistance;
      if (trailSl > newSlPrice) {
        newSlPrice = trailSl;
      }
    }
  } else {
    // Track peak ask price (lowest is best for SELL)
    const halfSpread = spread / 2;
    const currentAsk = candle.low + halfSpread;
    if (currentAsk < updatedPeak) {
      updatedPeak = currentAsk;
    }

    // Check breakeven activation
    if (!newBreakeven && updatedPeak <= position.entryPrice - breakevenThreshold) {
      newBreakeven = true;
      // V2.7: Micro-profit BE at entry - 0.15R (covers commission)
      newSlPrice = position.entryPrice - risk * 0.15;
    }

    // V2.7: Trailing stop for all trades
    if (newBreakeven) {
      const favorableMove = position.entryPrice - updatedPeak;
      const trailDistance = favorableMove >= risk * 1.5 ? risk * 0.75 : risk;
      const trailSl = updatedPeak + trailDistance;
      if (trailSl < newSlPrice) {
        newSlPrice = trailSl;
      }
    }
  }

  // Only create new object if something changed
  if (
    updatedPeak === position.peakFavorablePrice &&
    newSlPrice === position.slPrice &&
    newBreakeven === position.breakevenActivated
  ) {
    return position;
  }

  return {
    ...position,
    peakFavorablePrice: updatedPeak,
    slPrice: newSlPrice,
    breakevenActivated: newBreakeven,
  };
}

/**
 * Check if a candle triggers SL or TP on an open position.
 * Uses spread-adjusted bid/ask prices for exit checks.
 * If both SL and TP could hit on the same candle, SL always wins (conservative).
 */
export function checkPositionExit(
  position: SimulatedPosition,
  candle: BacktestCandle,
  spread: number,
  commission: number,
  lotSizeUnits: number,
): ClosedTrade | null {
  const { side, entryPrice, slPrice, tpPrice } = position;
  const halfSpread = spread / 2;

  let slHit = false;
  let tpHit = false;

  if (side === 'BUY') {
    // BUY exits at bid: bid = price - halfSpread
    slHit = candle.low - halfSpread <= slPrice;
    tpHit = candle.high - halfSpread >= tpPrice;
  } else {
    // SELL exits at ask: ask = price + halfSpread
    slHit = candle.high + halfSpread >= slPrice;
    tpHit = candle.low + halfSpread <= tpPrice;
  }

  if (!slHit && !tpHit) return null;

  // Conservative: when both SL and TP hit on the same candle, always assume SL first
  let exitReason: 'SL' | 'TP' | 'BREAKEVEN';
  if (slHit && tpHit) {
    exitReason = position.breakevenActivated ? 'BREAKEVEN' : 'SL';
  } else if (slHit) {
    exitReason = position.breakevenActivated ? 'BREAKEVEN' : 'SL';
  } else {
    exitReason = 'TP';
  }
  const exitPrice = exitReason === 'TP' ? tpPrice : slPrice;

  const pnl = calculatePnl(side, entryPrice, exitPrice, position.lotSize, commission, lotSizeUnits);

  return {
    side: position.side,
    entryPrice: position.entryPrice,
    exitPrice,
    slPrice: position.slPrice,
    tpPrice: position.tpPrice,
    lotSize: position.lotSize,
    pnl,
    commission,
    setupTags: position.setupTags,
    entryTime: position.entryTime,
    exitTime: candle.openTime,
    exitReason,
    h1Bias: position.h1Bias,
    rsiAtEntry: position.rsiAtEntry,
    atrAtEntry: position.atrAtEntry,
  };
}

/**
 * Force-close a position at the given price (end of data).
 */
export function forceClosePosition(
  position: SimulatedPosition,
  closePrice: number,
  closeTime: string,
  commission: number,
  lotSizeUnits: number,
): ClosedTrade {
  const pnl = calculatePnl(position.side, position.entryPrice, closePrice, position.lotSize, commission, lotSizeUnits);

  return {
    side: position.side,
    entryPrice: position.entryPrice,
    exitPrice: closePrice,
    slPrice: position.slPrice,
    tpPrice: position.tpPrice,
    lotSize: position.lotSize,
    pnl,
    commission,
    setupTags: position.setupTags,
    entryTime: position.entryTime,
    exitTime: closeTime,
    exitReason: 'FORCED_CLOSE',
    h1Bias: position.h1Bias,
    rsiAtEntry: position.rsiAtEntry,
    atrAtEntry: position.atrAtEntry,
  };
}

function calculatePnl(
  side: string,
  entryPrice: number,
  exitPrice: number,
  lotSize: number,
  commission: number,
  lotSizeUnits: number,
): number {
  const direction = side === 'BUY' ? 1 : -1;
  const priceDiff = (exitPrice - entryPrice) * direction;
  const rawPnl = priceDiff * lotSize * lotSizeUnits;
  const pnl = rawPnl - commission;
  return Math.round(pnl * 100) / 100;
}
