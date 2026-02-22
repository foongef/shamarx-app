import {
  BacktestCandle,
  IndicatorState,
  SwingPoint,
  BOSEvent,
} from './types';

/**
 * Detect swing points using left/right lookback.
 * Copied from strategy-service/structure-analyzer.ts for in-memory speed.
 */
export function detectSwingPoints(
  candles: BacktestCandle[],
  startIdx: number,
  endIdx: number,
  lookback: number = 2,
): SwingPoint[] {
  const points: SwingPoint[] = [];

  for (let i = Math.max(startIdx, lookback); i <= endIdx - lookback; i++) {
    const curr = candles[i];

    let isSwingHigh = true;
    for (let j = 1; j <= lookback; j++) {
      if (
        candles[i - j].high >= curr.high ||
        candles[i + j].high >= curr.high
      ) {
        isSwingHigh = false;
        break;
      }
    }
    if (isSwingHigh) {
      points.push({ index: i, price: curr.high, type: 'HIGH' });
    }

    let isSwingLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (
        candles[i - j].low <= curr.low ||
        candles[i + j].low <= curr.low
      ) {
        isSwingLow = false;
        break;
      }
    }
    if (isSwingLow) {
      points.push({ index: i, price: curr.low, type: 'LOW' });
    }
  }

  return points;
}

/**
 * Detect Break of Structure at given candle index.
 */
export function detectBOS(
  candles: BacktestCandle[],
  swingPoints: SwingPoint[],
  candleIdx: number,
): BOSEvent | null {
  if (swingPoints.length < 3) return null;

  const recentPoints = swingPoints.slice(-6);
  const candle = candles[candleIdx];

  const swingHighs = recentPoints.filter((p) => p.type === 'HIGH');
  const swingLows = recentPoints.filter((p) => p.type === 'LOW');

  if (swingHighs.length === 0 || swingLows.length === 0) return null;

  const lastSwingHigh = swingHighs[swingHighs.length - 1];
  const lastSwingLow = swingLows[swingLows.length - 1];

  if (candle.close > lastSwingHigh.price) {
    return {
      direction: 'BUY',
      brokenLevel: lastSwingHigh.price,
      candleIndex: candleIdx,
    };
  }

  if (candle.close < lastSwingLow.price) {
    return {
      direction: 'SELL',
      brokenLevel: lastSwingLow.price,
      candleIndex: candleIdx,
    };
  }

  return null;
}

/**
 * Detect engulfing pattern at the last candle in slice.
 */
export function detectEngulfing(
  candles: BacktestCandle[],
  idx: number,
): boolean {
  if (idx < 1) return false;
  const prev = candles[idx - 1];
  const curr = candles[idx];

  const isBullishEngulfing =
    prev.close < prev.open &&
    curr.close > curr.open &&
    curr.open <= prev.close &&
    curr.close >= prev.open;

  const isBearishEngulfing =
    prev.close > prev.open &&
    curr.close < curr.open &&
    curr.open >= prev.close &&
    curr.close <= prev.open;

  return isBullishEngulfing || isBearishEngulfing;
}

/**
 * Detect strong close (body >= 60% of range, close in upper/lower 25%).
 */
export function detectStrongClose(
  candles: BacktestCandle[],
  idx: number,
): boolean {
  const curr = candles[idx];
  const range = curr.high - curr.low;
  if (range === 0) return false;

  const body = Math.abs(curr.close - curr.open);
  const bodyRatio = body / range;
  if (bodyRatio < 0.6) return false;

  const isBullish = curr.close > curr.open;
  if (isBullish) {
    return (curr.close - curr.low) / range >= 0.75;
  } else {
    return (curr.high - curr.close) / range >= 0.75;
  }
}

/**
 * Check if candle pulled back to an EMA value.
 */
export function isPullbackToEMA(
  candle: BacktestCandle,
  emaValue: number,
  atr: number,
): boolean {
  if (!emaValue || !atr || isNaN(emaValue) || isNaN(atr)) return false;
  const tolerance = atr * 0.5;
  return candle.low <= emaValue + tolerance && candle.high >= emaValue - tolerance;
}

/**
 * Check RSI alignment with direction.
 */
export function isRSIAligned(rsi: number, isBullish: boolean): boolean {
  if (isNaN(rsi)) return false;
  if (isBullish) return rsi > 50 && rsi < 70;
  return rsi < 50 && rsi > 30;
}

/**
 * Get H1 bias from H1 candles using binary search for most recent H1 candle <= current M15 time.
 */
export function getH1Bias(
  h1Candles: BacktestCandle[],
  h1Indicators: IndicatorState,
  currentTime: string,
): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
  // Binary search for the most recent H1 candle at or before currentTime
  const target = new Date(currentTime).getTime();
  let lo = 0;
  let hi = h1Candles.length - 1;
  let bestIdx = -1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const midTime = new Date(h1Candles[mid].openTime).getTime();
    if (midTime <= target) {
      bestIdx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (bestIdx < 0 || isNaN(h1Indicators.ema20[bestIdx]) || isNaN(h1Indicators.ema50[bestIdx])) {
    return 'NEUTRAL';
  }

  const h1Close = h1Candles[bestIdx].close;
  const h1Ema20 = h1Indicators.ema20[bestIdx];
  const h1Ema50 = h1Indicators.ema50[bestIdx];

  // H1 bullish: price above both EMAs, EMA20 > EMA50
  if (h1Close > h1Ema20 && h1Close > h1Ema50 && h1Ema20 > h1Ema50) {
    return 'BULLISH';
  }
  // H1 bearish: price below both EMAs, EMA20 < EMA50
  if (h1Close < h1Ema20 && h1Close < h1Ema50 && h1Ema20 < h1Ema50) {
    return 'BEARISH';
  }

  return 'NEUTRAL';
}

export interface SetupSignal {
  side: 'BUY' | 'SELL';
  entryPrice: number;
  slPrice: number;
  tpPrice: number;
  setupTags: string[];
  h1Bias: string;
  rsiAtEntry: number;
  atrAtEntry: number;
}

/**
 * Evaluate whether candle at idx produces a valid setup.
 * Returns a signal if all confirmations pass, null otherwise.
 */
export function evaluateSetup(
  m15Candles: BacktestCandle[],
  m15Indicators: IndicatorState,
  h1Candles: BacktestCandle[],
  h1Indicators: IndicatorState,
  idx: number,
): SetupSignal | null {
  // Need at least 50 prior candles
  if (idx < 50) return null;

  const ema20 = m15Indicators.ema20[idx];
  const ema50 = m15Indicators.ema50[idx];
  const rsi = m15Indicators.rsi14[idx];
  const atr = m15Indicators.atr14[idx];

  if (isNaN(ema20) || isNaN(ema50) || isNaN(rsi) || isNaN(atr)) return null;

  // Detect swing points over recent 50 candles
  const windowStart = Math.max(0, idx - 50);
  const swingPoints = detectSwingPoints(m15Candles, windowStart, idx);
  const bos = detectBOS(m15Candles, swingPoints, idx);

  if (!bos) return null;

  const isBullish = bos.direction === 'BUY';

  // Check H1 bias alignment
  const h1Bias = getH1Bias(h1Candles, h1Indicators, m15Candles[idx].openTime);
  const biasAligned =
    (isBullish && h1Bias === 'BULLISH') ||
    (!isBullish && h1Bias === 'BEARISH');

  // Gather confirmation tags
  const tags: string[] = ['BOS'];

  if (detectEngulfing(m15Candles, idx)) tags.push('ENGULFING');
  if (detectStrongClose(m15Candles, idx)) tags.push('STRONG_CLOSE');
  if (isPullbackToEMA(m15Candles[idx], ema20, atr)) tags.push('PULLBACK_EMA20');
  if (isPullbackToEMA(m15Candles[idx], ema50, atr)) tags.push('PULLBACK_EMA50');
  if (isRSIAligned(rsi, isBullish)) tags.push('RSI_ALIGNED');
  if (biasAligned) tags.push('H1_BIAS_ALIGNED');

  // Require pullback + confirmation
  const hasPullback = tags.includes('PULLBACK_EMA20') || tags.includes('PULLBACK_EMA50');
  const hasConfirmation = tags.includes('ENGULFING') || tags.includes('STRONG_CLOSE');

  if (!hasPullback || !hasConfirmation) return null;

  // Compute entry, SL, TP
  const entryPrice = m15Candles[idx].close;

  let slPrice: number;
  let tpPrice: number;

  if (isBullish) {
    const recentLows = swingPoints
      .filter((p) => p.type === 'LOW')
      .slice(-3)
      .map((p) => p.price);
    const swingSL = recentLows.length > 0 ? Math.min(...recentLows) : 0;
    const atrSL = entryPrice - atr * 1.5;
    slPrice = Math.max(swingSL, atrSL);
    const slPoints = entryPrice - slPrice;
    tpPrice = entryPrice + slPoints * 2;
  } else {
    const recentHighs = swingPoints
      .filter((p) => p.type === 'HIGH')
      .slice(-3)
      .map((p) => p.price);
    const swingSL = recentHighs.length > 0 ? Math.max(...recentHighs) : 0;
    const atrSL = entryPrice + atr * 1.5;
    slPrice = Math.min(swingSL, atrSL);
    const slPoints = slPrice - entryPrice;
    tpPrice = entryPrice - slPoints * 2;
  }

  // Validate SL/TP sanity
  const slDistance = Math.abs(entryPrice - slPrice);
  if (slDistance < atr * 0.3 || slDistance > atr * 5) return null;

  return {
    side: bos.direction,
    entryPrice: Math.round(entryPrice * 100) / 100,
    slPrice: Math.round(slPrice * 100) / 100,
    tpPrice: Math.round(tpPrice * 100) / 100,
    setupTags: tags,
    h1Bias,
    rsiAtEntry: Math.round(rsi * 100) / 100,
    atrAtEntry: Math.round(atr * 100) / 100,
  };
}
