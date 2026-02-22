import { BacktestCandle, SimulatedPosition, ClosedTrade } from './types';

const LOT_SIZE_UNITS = 100; // 1 lot = 100 oz for gold

/**
 * Check if a candle triggers SL or TP on an open position.
 * If both could hit on the same candle, SL wins (conservative).
 */
export function checkPositionExit(
  position: SimulatedPosition,
  candle: BacktestCandle,
): ClosedTrade | null {
  const { side, entryPrice, slPrice, tpPrice } = position;

  let slHit = false;
  let tpHit = false;

  if (side === 'BUY') {
    slHit = candle.low <= slPrice;
    tpHit = candle.high >= tpPrice;
  } else {
    slHit = candle.high >= slPrice;
    tpHit = candle.low <= tpPrice;
  }

  if (!slHit && !tpHit) return null;

  // When both SL and TP hit on the same candle, use candle direction to infer order
  let exitReason: 'SL' | 'TP';
  if (slHit && tpHit) {
    const isBullishCandle = candle.close > candle.open;
    if (side === 'BUY') {
      exitReason = isBullishCandle ? 'TP' : 'SL';
    } else {
      exitReason = isBullishCandle ? 'SL' : 'TP';
    }
  } else {
    exitReason = slHit ? 'SL' : 'TP';
  }
  const exitPrice = exitReason === 'SL' ? slPrice : tpPrice;

  const pnl = calculatePnl(side, entryPrice, exitPrice, position.lotSize);

  return {
    side: position.side,
    entryPrice: position.entryPrice,
    exitPrice,
    slPrice: position.slPrice,
    tpPrice: position.tpPrice,
    lotSize: position.lotSize,
    pnl,
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
): ClosedTrade {
  const pnl = calculatePnl(position.side, position.entryPrice, closePrice, position.lotSize);

  return {
    side: position.side,
    entryPrice: position.entryPrice,
    exitPrice: closePrice,
    slPrice: position.slPrice,
    tpPrice: position.tpPrice,
    lotSize: position.lotSize,
    pnl,
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
): number {
  const direction = side === 'BUY' ? 1 : -1;
  const priceDiff = (exitPrice - entryPrice) * direction;
  // Gold: PnL = price diff * lot_size * 100 oz
  const pnl = priceDiff * lotSize * LOT_SIZE_UNITS;
  return Math.round(pnl * 100) / 100;
}
