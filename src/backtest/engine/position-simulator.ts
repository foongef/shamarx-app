import { BacktestCandle, SimulatedPosition, ClosedTrade, RegimeTradeParams } from './types';

// Default trail config (matches STRONG_TREND behavior from V5.5b)
const DEFAULT_TRAIL_CONFIG: RegimeTradeParams = {
  trendTpR: 2.0,
  fvgTpR: 1.0,
  beThresholdR: 1.0,
  tpRemovalR: 2.0,
  slClampMaxAtr: 3.0,
};

/**
 * V6: Update trade management with regime-adaptive parameters.
 *
 * Reads trail config from position.trailConfig (set at entry from RegimeTradeParams).
 * Different regimes get different BE thresholds, TP removal thresholds, and trail tightness.
 */
export function updatePositionManagement(
  position: SimulatedPosition,
  candle: BacktestCandle,
  spread: number,
): SimulatedPosition {
  // Range trades: no dynamic management — fixed SL/TP only
  if (position.setupTags.includes('RANGE_ENGINE')) {
    return position;
  }

  const risk = Math.abs(position.entryPrice - position.originalSlPrice);
  const config = position.trailConfig ?? DEFAULT_TRAIL_CONFIG;
  const isFVG = position.setupTags.includes('FVG_FILL');

  // V6: Regime-adaptive breakeven threshold
  const breakevenThreshold = risk * config.beThresholdR;

  // V6: Regime-adaptive TP removal threshold (0 = never remove)
  const tpRemovalThreshold = config.tpRemovalR > 0 ? risk * config.tpRemovalR : Infinity;

  let updatedPeak = position.peakFavorablePrice;
  let newSlPrice = position.slPrice;
  let newBreakeven = position.breakevenActivated;
  let newTpPrice = position.tpPrice;

  if (position.side === 'BUY') {
    const halfSpread = spread / 2;
    const currentBid = candle.high - halfSpread;
    if (currentBid > updatedPeak) {
      updatedPeak = currentBid;
    }

    if (!newBreakeven && updatedPeak >= position.entryPrice + breakevenThreshold) {
      newBreakeven = true;
      newSlPrice = position.entryPrice + risk * 0.1;
    }

    if (newBreakeven) {
      const favorableMove = updatedPeak - position.entryPrice;

      // V6: Remove TP at regime-adaptive threshold
      if (favorableMove >= tpRemovalThreshold && newTpPrice !== null) {
        newTpPrice = null;
      }

      // V6: Trail tiers adapt to regime (tighter in volatile/ranging, wider in strong trend)
      const trailDistance = computeTrailDistance(favorableMove, risk, config, isFVG);
      const trailSl = updatedPeak - trailDistance;
      if (trailSl > newSlPrice) newSlPrice = trailSl;
    }
  } else {
    const halfSpread = spread / 2;
    const currentAsk = candle.low + halfSpread;
    if (currentAsk < updatedPeak) {
      updatedPeak = currentAsk;
    }

    if (!newBreakeven && updatedPeak <= position.entryPrice - breakevenThreshold) {
      newBreakeven = true;
      newSlPrice = position.entryPrice - risk * 0.1;
    }

    if (newBreakeven) {
      const favorableMove = position.entryPrice - updatedPeak;

      if (favorableMove >= tpRemovalThreshold && newTpPrice !== null) {
        newTpPrice = null;
      }

      const trailDistance = computeTrailDistance(favorableMove, risk, config, isFVG);
      const trailSl = updatedPeak + trailDistance;
      if (trailSl < newSlPrice) newSlPrice = trailSl;
    }
  }

  // Only create new object if something changed
  if (
    updatedPeak === position.peakFavorablePrice &&
    newSlPrice === position.slPrice &&
    newBreakeven === position.breakevenActivated &&
    newTpPrice === position.tpPrice
  ) {
    return position;
  }

  return {
    ...position,
    peakFavorablePrice: updatedPeak,
    slPrice: newSlPrice,
    breakevenActivated: newBreakeven,
    tpPrice: newTpPrice,
  };
}

/**
 * V6: Compute trail distance based on favorable move, risk, and regime config.
 *
 * Strong trends: wide trail (let winners run)
 * Volatile/Ranging: tight trail (lock in profit fast)
 */
function computeTrailDistance(
  favorableMove: number,
  risk: number,
  config: RegimeTradeParams,
  isFVG: boolean,
): number {
  // Trail tightness scales with slClampMaxAtr — wider clamp = wider trail = more aggressive regime
  // STRONG_TREND (3.0): loosest trail, VOLATILE (1.5): tightest trail
  const tightnessFactor = Math.min(1.0, config.slClampMaxAtr / 3.0); // 0.5 to 1.0

  if (isFVG) {
    // FVG trail — structural, slightly tighter than trend
    if (favorableMove >= risk * 3.0) return risk * (0.4 + 0.1 * tightnessFactor);
    if (favorableMove >= risk * 2.0) return risk * (0.5 + 0.1 * tightnessFactor);
    if (favorableMove >= risk * 1.5) return risk * (0.6 + 0.1 * tightnessFactor);
    return risk;
  } else {
    // Trend trail — 5-tier with regime-adaptive tightness
    if (favorableMove >= risk * 5.0) return risk * (0.3 + 0.1 * tightnessFactor);
    if (favorableMove >= risk * 4.0) return risk * (0.4 + 0.1 * tightnessFactor);
    if (favorableMove >= risk * 3.0) return risk * (0.5 + 0.1 * tightnessFactor);
    if (favorableMove >= risk * 2.0) return risk * (0.6 + 0.15 * tightnessFactor);
    return risk;
  }
}

/**
 * Check if a candle triggers SL or TP on an open position.
 */
export function checkPositionExit(
  position: SimulatedPosition,
  candle: BacktestCandle,
  spread: number,
  commission: number,
  lotSizeUnits: number,
  symbol?: string,
): ClosedTrade | null {
  const { side, entryPrice, slPrice, tpPrice } = position;
  const halfSpread = spread / 2;

  let slHit = false;
  let tpHit = false;

  if (side === 'BUY') {
    slHit = candle.low - halfSpread <= slPrice;
    tpHit = tpPrice !== null && candle.high - halfSpread >= tpPrice;
  } else {
    slHit = candle.high + halfSpread >= slPrice;
    tpHit = tpPrice !== null && candle.low + halfSpread <= tpPrice;
  }

  if (!slHit && !tpHit) return null;

  let exitReason: 'SL' | 'TP' | 'BREAKEVEN';
  if (slHit && tpHit) {
    if (position.breakevenActivated) {
      exitReason = 'TP';
    } else {
      exitReason = 'SL';
    }
  } else if (slHit) {
    exitReason = position.breakevenActivated ? 'BREAKEVEN' : 'SL';
  } else {
    exitReason = 'TP';
  }
  const exitPrice = exitReason === 'TP' ? tpPrice! : slPrice;

  const pnl = calculatePnl(side, entryPrice, exitPrice, position.lotSize, commission, lotSizeUnits, symbol);

  // V6: Calculate R-multiple — riskPerUnit × lotSizeUnits is in quote currency;
  // for JPY pairs convert to USD via the entry price.
  const riskPerUnit = Math.abs(entryPrice - position.originalSlPrice);
  const isJpyPair = symbol ? symbol.endsWith('JPY') : false;
  const usdRiskPerLot = isJpyPair && entryPrice > 0
    ? (riskPerUnit * lotSizeUnits) / entryPrice
    : riskPerUnit * lotSizeUnits;
  const rMultiple = usdRiskPerLot > 0 ? (pnl + commission) / (usdRiskPerLot * position.lotSize) : 0;

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
    rMultiple: Math.round(rMultiple * 100) / 100,
    regimeAtEntry: position.regimeAtEntry,
    engineType: position.setupTags.includes('RANGE_ENGINE') ? 'RANGE_ENGINE'
      : position.setupTags.includes('FVG_FILL') ? 'FVG_FILL'
      : 'TREND_PULLBACK',
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
  symbol?: string,
): ClosedTrade {
  const pnl = calculatePnl(position.side, position.entryPrice, closePrice, position.lotSize, commission, lotSizeUnits, symbol);

  const riskPerUnit = Math.abs(position.entryPrice - position.originalSlPrice);
  const isJpyPair = symbol ? symbol.endsWith('JPY') : false;
  const usdRiskPerLot = isJpyPair && position.entryPrice > 0
    ? (riskPerUnit * lotSizeUnits) / position.entryPrice
    : riskPerUnit * lotSizeUnits;
  const rMultiple = usdRiskPerLot > 0 ? (pnl + commission) / (usdRiskPerLot * position.lotSize) : 0;

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
    rMultiple: Math.round(rMultiple * 100) / 100,
    regimeAtEntry: position.regimeAtEntry,
    engineType: position.setupTags.includes('RANGE_ENGINE') ? 'RANGE_ENGINE'
      : position.setupTags.includes('FVG_FILL') ? 'FVG_FILL'
      : 'TREND_PULLBACK',
  };
}

function calculatePnl(
  side: string,
  entryPrice: number,
  exitPrice: number,
  lotSize: number,
  commission: number,
  lotSizeUnits: number,
  symbol?: string,
): number {
  const direction = side === 'BUY' ? 1 : -1;
  const priceDiff = (exitPrice - entryPrice) * direction;
  let rawPnl = priceDiff * lotSize * lotSizeUnits;
  // For JPY-quote pairs (USDJPY, EURJPY, GBPJPY, etc.) the raw P&L is denominated
  // in JPY, not USD. Divide by the quote (USD/JPY rate ≈ exitPrice) to convert.
  if (symbol && symbol.endsWith('JPY')) {
    rawPnl /= exitPrice;
  }
  const pnl = rawPnl - commission;
  return Math.round(pnl * 100) / 100;
}
