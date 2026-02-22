import { BacktestCandle, SimulatedPosition, ClosedTrade } from './types';

const LOT_SIZE_UNITS = 100; // 1 lot = 100 oz for gold

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
  let exitReason: 'SL' | 'TP';
  if (slHit && tpHit) {
    exitReason = 'SL';
  } else {
    exitReason = slHit ? 'SL' : 'TP';
  }
  const exitPrice = exitReason === 'SL' ? slPrice : tpPrice;

  const pnl = calculatePnl(side, entryPrice, exitPrice, position.lotSize, commission);

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
): ClosedTrade {
  const pnl = calculatePnl(position.side, position.entryPrice, closePrice, position.lotSize, commission);

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
): number {
  const direction = side === 'BUY' ? 1 : -1;
  const priceDiff = (exitPrice - entryPrice) * direction;
  // Gold: PnL = price diff * lot_size * 100 oz, minus commission
  const rawPnl = priceDiff * lotSize * LOT_SIZE_UNITS;
  const pnl = rawPnl - commission;
  return Math.round(pnl * 100) / 100;
}
