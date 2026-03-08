import {
  BacktestCandle,
  IndicatorState,
  SwingPoint,
} from './types';

// ─── Regime Detection (H1 ADX) ─────────────────────────────────────────────

export type MarketRegime = 'BULLISH' | 'BEARISH' | 'RANGING';

export function getMarketRegime(
  h1Indicators: IndicatorState,
  h1Idx: number,
): MarketRegime {
  const adx = h1Indicators.adx14[h1Idx];
  const plusDI = h1Indicators.plusDI14[h1Idx];
  const minusDI = h1Indicators.minusDI14[h1Idx];

  if (isNaN(adx) || isNaN(plusDI) || isNaN(minusDI)) return 'RANGING';
  if (adx < 20) return 'RANGING';

  // V2.2: DI separation — directional dominance (relaxed from 5 to 3)
  if (Math.abs(plusDI - minusDI) < 3) return 'RANGING';

  return plusDI > minusDI ? 'BULLISH' : 'BEARISH';
}

// ─── DST-Safe Session Filter ────────────────────────────────────────────────

function getLocalHour(utcTime: string, tz: string): number {
  const d = new Date(utcTime);
  return parseInt(
    new Intl.DateTimeFormat('en', {
      hour: 'numeric',
      hour12: false,
      timeZone: tz,
    }).format(d),
  );
}

export function isActiveTradingSession(openTime: string): boolean {
  const londonHour = getLocalHour(openTime, 'Europe/London');
  // London: local 08:00-16:59 — full London session + London-NY overlap
  if (londonHour >= 8 && londonHour < 17) return true;

  const nyHour = getLocalHour(openTime, 'America/New_York');
  // New York: local 08:00-13:59 — full US morning + early afternoon
  if (nyHour >= 8 && nyHour < 14) return true;

  return false;
}

// ─── H1 Trend Confirmation (relaxed EMA cross) ─────────────────────────────

export function getH1Bias(
  h1Candles: BacktestCandle[],
  h1Indicators: IndicatorState,
  currentTime: string,
): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
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

  if (bestIdx < 0) return 'NEUTRAL';

  const ema20 = h1Indicators.ema20[bestIdx];
  const ema50 = h1Indicators.ema50[bestIdx];

  if (isNaN(ema20) || isNaN(ema50)) return 'NEUTRAL';

  // Relaxed: just EMA20 vs EMA50 cross direction
  if (ema20 > ema50) return 'BULLISH';
  if (ema20 < ema50) return 'BEARISH';
  return 'NEUTRAL';
}

/**
 * V2.8: Check if H1 regime has been stable (same regime) for the last N H1 bars.
 * Returns false if regime flipped recently — prevents whipsaw entries.
 */
export function isH1RegimeStable(
  h1Candles: BacktestCandle[],
  h1Indicators: IndicatorState,
  currentTime: string,
  lookback: number = 2,
): boolean {
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

  if (bestIdx < lookback) return false;

  const currentRegime = getMarketRegime(h1Indicators, bestIdx);
  for (let k = 1; k <= lookback; k++) {
    if (getMarketRegime(h1Indicators, bestIdx - k) !== currentRegime) {
      return false;
    }
  }
  return true;
}

/**
 * Get the H1 regime at a given M15 candle time.
 * Uses binary search to find the matching H1 candle.
 */
export function getH1Regime(
  h1Candles: BacktestCandle[],
  h1Indicators: IndicatorState,
  currentTime: string,
): { regime: MarketRegime; bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'; h1Adx: number; adxRising: boolean } {
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

  if (bestIdx < 0) {
    return { regime: 'RANGING', bias: 'NEUTRAL', h1Adx: 0, adxRising: false };
  }

  const regime = getMarketRegime(h1Indicators, bestIdx);
  const ema20 = h1Indicators.ema20[bestIdx];
  const ema50 = h1Indicators.ema50[bestIdx];
  const h1Adx = h1Indicators.adx14[bestIdx];

  let bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
  if (!isNaN(ema20) && !isNaN(ema50)) {
    bias = ema20 > ema50 ? 'BULLISH' : ema20 < ema50 ? 'BEARISH' : 'NEUTRAL';
  }

  // V2.6: Check if ADX is rising (compare with 2 H1 candles back = 2hr lookback)
  const adxPrev = bestIdx >= 2 ? h1Indicators.adx14[bestIdx - 2] : NaN;
  const adxRising = !isNaN(adxPrev) && h1Adx > adxPrev;

  return { regime, bias, h1Adx: isNaN(h1Adx) ? 0 : h1Adx, adxRising };
}

// ─── Swing Points (kept from V1) ───────────────────────────────────────────

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

// ─── Confirmation Patterns (kept from V1) ──────────────────────────────────

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

// ─── Pin Bar Detection ──────────────────────────────────────────────────────

export function detectPinBar(
  candles: BacktestCandle[],
  idx: number,
  side: 'BUY' | 'SELL',
): boolean {
  const curr = candles[idx];
  const range = curr.high - curr.low;
  if (range === 0) return false;

  const body = Math.abs(curr.close - curr.open);
  const bodyRatio = body / range;
  if (bodyRatio > 0.4) return false; // body must be ≤ 40% of range

  const upperWick = curr.high - Math.max(curr.open, curr.close);
  const lowerWick = Math.min(curr.open, curr.close) - curr.low;

  if (side === 'BUY') {
    // BUY pin bar: long lower wick (rejection from below)
    return lowerWick / range >= 0.6 && upperWick / range <= 0.25;
  } else {
    // SELL pin bar: long upper wick (rejection from above)
    return upperWick / range >= 0.6 && lowerWick / range <= 0.25;
  }
}

// ─── V2.2 Setup Signal ──────────────────────────────────────────────────────

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
 * V2.2 Strategy: Trend-following pullback to EMA20/EMA50 with regime + session filters.
 *
 * Entry conditions:
 * 1. H1 ADX >= 20, with DI separation >= 3 (trending regime)
 * 2. Active trading session (London 08-17 / NY 08-14, DST-safe)
 * 3. H1 EMA20/EMA50 bias agrees with ADX DI direction
 * 4. M15 price pulls back to EMA20 zone (within ATR*0.6) or EMA50 zone for strong trends
 * 5. Candle shows directional commitment (touches EMA zone, closes in trade direction)
 * 6. Engulfing, strong close, or pin bar confirmation
 * 7. RSI in valid range (35-70 BUY, 30-65 SELL)
 *
 * @param spread - bid/ask spread in points for entry price adjustment
 */
export function evaluateSetup(
  m15Candles: BacktestCandle[],
  m15Indicators: IndicatorState,
  h1Candles: BacktestCandle[],
  h1Indicators: IndicatorState,
  idx: number,
  spread: number,
  minAtr: number,
  pricePrecision: number,
): SetupSignal | null {
  if (idx < 50) return null;

  const candle = m15Candles[idx];
  const ema20 = m15Indicators.ema20[idx];
  const ema50 = m15Indicators.ema50[idx];
  const rsi = m15Indicators.rsi14[idx];
  const atr = m15Indicators.atr14[idx];

  if (isNaN(ema20) || isNaN(ema50) || isNaN(rsi) || isNaN(atr) || atr === 0) return null;

  // Minimum volatility — low ATR markets get stopped on noise
  if (atr < minAtr) return null;

  // V4: HIGH_VOLATILITY filter — ATR spiking vs baseline means chaotic price action
  const atrBaseline = m15Indicators.atrBaseline[idx];
  if (!isNaN(atrBaseline) && atrBaseline > 0 && atr / atrBaseline >= 1.6) return null;

  // Filter 1: Session filter (DST-safe)
  if (!isActiveTradingSession(candle.openTime)) return null;

  // Filter 2: H1 regime + bias (includes ADX + DI separation)
  const { regime, bias, h1Adx, adxRising } = getH1Regime(h1Candles, h1Indicators, candle.openTime);
  if (regime === 'RANGING') return null;
  if (bias === 'NEUTRAL') return null;
  if (regime !== bias) return null;

  // V2.8: Regime stability — require same H1 regime for 3 prior bars
  if (!isH1RegimeStable(h1Candles, h1Indicators, candle.openTime)) return null;

  // V3.2: Fading trend — reject ANY declining ADX (compensates for lower threshold)
  if (!adxRising) return null;

  // V2.7: 3-tier ADX system (replaces SCALP/TREND binary)
  let adxTier: 'WEAK_TREND' | 'MODERATE_TREND' | 'STRONG_TREND';
  if (h1Adx < 24) {
    adxTier = 'WEAK_TREND';
  } else if (h1Adx < 25) {
    adxTier = 'MODERATE_TREND';
  } else {
    adxTier = 'STRONG_TREND';
  }

  // V3.1: Only STRONG_TREND for trend engine — WEAK/MODERATE are net negative
  if (['WEAK_TREND', 'MODERATE_TREND'].includes(adxTier)) return null;

  const isBullish = regime === 'BULLISH';

  // V2.7: Quality gate for weak trends — confirmation candle body must exceed avg of prior 3
  if (adxTier === 'WEAK_TREND') {
    const currBody = Math.abs(candle.close - candle.open);
    let sumPriorBodies = 0;
    let count = 0;
    for (let k = 1; k <= 3 && idx - k >= 0; k++) {
      sumPriorBodies += Math.abs(m15Candles[idx - k].close - m15Candles[idx - k].open);
      count++;
    }
    if (count === 0 || currBody <= sumPriorBodies / count) return null;
  }

  // V2.6: EMA20 slope — must be trending in trade direction (4 M15 candles = 1hr lookback)
  if (idx >= 4) {
    const ema20Prev = m15Indicators.ema20[idx - 4];
    if (!isNaN(ema20Prev)) {
      if (isBullish && ema20 <= ema20Prev) return null;
      if (!isBullish && ema20 >= ema20Prev) return null;
    }
  }

  // V2.6: RSI range — tightened to filter weak momentum entries
  if (isBullish && (rsi < 40 || rsi > 65)) return null;
  if (!isBullish && (rsi < 35 || rsi > 60)) return null;

  // Determine pullback target: EMA20 first, then EMA50 for strong trends
  const ema20Tolerance = atr * 0.6;
  const touchesEma20 = candle.low <= ema20 + ema20Tolerance && candle.high >= ema20 - ema20Tolerance;

  let pullbackTarget: 'EMA20' | 'EMA50' = 'EMA20';
  let pullbackEma = ema20;
  let pullbackTolerance = ema20Tolerance;

  if (!touchesEma20) {
    // V2.7: Reject EMA50 pullbacks for weak trends — too deep for 1.2R target
    if (adxTier === 'WEAK_TREND') return null;

    // Try EMA50 for strong trends only (ADX >= 25, using h1Adx from getH1Regime)
    if (!isNaN(h1Adx) && h1Adx >= 25) {
      const ema50Tolerance = atr * 0.75;
      const touchesEma50 = candle.low <= ema50 + ema50Tolerance && candle.high >= ema50 - ema50Tolerance;
      const emaSeparation = Math.abs(ema20 - ema50);

      if (touchesEma50 && emaSeparation >= atr * 0.5) {
        pullbackTarget = 'EMA50';
        pullbackEma = ema50;
        pullbackTolerance = ema50Tolerance;
      } else {
        return null; // No valid pullback zone
      }
    } else {
      return null; // Doesn't touch EMA20 and not strong enough for EMA50
    }
  }

  // Directional commitment: candle dips to EMA zone and closes in trade direction
  if (isBullish) {
    if (candle.low > pullbackEma + pullbackTolerance * 0.5) return null;
    if (candle.close <= pullbackEma) return null;
    if (candle.close <= candle.open) return null;
  } else {
    if (candle.high < pullbackEma - pullbackTolerance * 0.5) return null;
    if (candle.close >= pullbackEma) return null;
    if (candle.close >= candle.open) return null;
  }

  // EMA50 extra check: candle must close beyond EMA50 in trade direction
  if (pullbackTarget === 'EMA50') {
    if (isBullish && candle.close <= ema50) return null;
    if (!isBullish && candle.close >= ema50) return null;
  }

  // Confirmation pattern
  const hasEngulfing = detectEngulfing(m15Candles, idx);
  const hasStrongClose = detectStrongClose(m15Candles, idx);
  if (!hasEngulfing && !hasStrongClose) return null;

  // Build tags
  const tags: string[] = [
    pullbackTarget === 'EMA50' ? 'PULLBACK_EMA50' : 'PULLBACK_EMA20',
    'V3.1',
    adxTier,
  ];
  if (hasEngulfing) tags.push('ENGULFING');
  if (hasStrongClose) tags.push('STRONG_CLOSE');
  tags.push(regime === 'BULLISH' ? 'ADX_BULL' : 'ADX_BEAR');

  // Spread-adjusted entry price
  const halfSpread = spread / 2;
  const entryPrice = isBullish
    ? candle.close + halfSpread  // BUY filled at ask
    : candle.close - halfSpread; // SELL filled at bid

  const spreadBuffer = atr * 0.3;

  const windowStart = Math.max(0, idx - 50);
  const swingPoints = detectSwingPoints(m15Candles, windowStart, idx);

  let slPrice: number;

  if (isBullish) {
    const recentLows = swingPoints
      .filter((p) => p.type === 'LOW')
      .slice(-3)
      .map((p) => p.price);
    const swingSL = recentLows.length > 0 ? Math.min(...recentLows) : entryPrice - atr * 2.0;
    const emaFloor = pullbackTarget === 'EMA50' ? ema50 - atr * 1.0 : entryPrice - atr * 1.0;
    slPrice = Math.min(swingSL, emaFloor) - spreadBuffer;
  } else {
    const recentHighs = swingPoints
      .filter((p) => p.type === 'HIGH')
      .slice(-3)
      .map((p) => p.price);
    const swingSL = recentHighs.length > 0 ? Math.max(...recentHighs) : entryPrice + atr * 2.0;
    const emaCeiling = pullbackTarget === 'EMA50' ? ema50 + atr * 1.0 : entryPrice + atr * 1.0;
    slPrice = Math.max(swingSL, emaCeiling) + spreadBuffer;
  }

  // V2.7: Tiered SL clamp — WEAK ATR×2.0, MODERATE ATR×2.5, STRONG ATR×3.0
  const slClampMax = adxTier === 'WEAK_TREND' ? atr * 2.0
    : adxTier === 'MODERATE_TREND' ? atr * 2.5
    : atr * 3.0;
  const slDistance = Math.abs(entryPrice - slPrice);
  if (slDistance < atr * 1.0) {
    slPrice = isBullish ? entryPrice - atr * 1.0 : entryPrice + atr * 1.0;
  }
  if (slDistance > slClampMax) {
    slPrice = isBullish ? entryPrice - slClampMax : entryPrice + slClampMax;
  }

  // V2.7: Tiered TP — WEAK 1.2R, MODERATE 1.5R, STRONG 2.0R
  const tpMultiplier = adxTier === 'WEAK_TREND' ? 1.2
    : adxTier === 'MODERATE_TREND' ? 1.5
    : 2.0;
  const risk = Math.abs(entryPrice - slPrice);
  const tpPrice = isBullish ? entryPrice + risk * tpMultiplier : entryPrice - risk * tpMultiplier;

  const factor = Math.pow(10, pricePrecision);

  return {
    side: isBullish ? 'BUY' : 'SELL',
    entryPrice: Math.round(entryPrice * factor) / factor,
    slPrice: Math.round(slPrice * factor) / factor,
    tpPrice: Math.round(tpPrice * factor) / factor,
    setupTags: tags,
    h1Bias: bias,
    rsiAtEntry: Math.round(rsi * 100) / 100,
    atrAtEntry: Math.round(atr * 100000) / 100000,
  };
}

// ─── V3.1 Range Engine ──────────────────────────────────────────────────────

/**
 * V3.1: Mean reversion strategy for RANGING markets (H1 ADX < 20).
 *
 * Entry conditions:
 * 1. H1 ADX < 20 (confirmed ranging)
 * 2. Active session (same London/NY filter)
 * 3. Price at ATR band extreme (EMA50 ± ATR*1.5)
 *    - BUY: candle low touches lower band, RSI < 30, bullish close
 *    - SELL: candle high touches upper band, RSI > 70, bearish close
 * 4. Confirmation: engulfing, strong close, or pin bar
 *
 * Exit:
 * - TP: EMA50 (midline of range)
 * - SL: Beyond ATR band + buffer, clamped ATR*0.5 to ATR*2.0
 * - R:R gate: skip if reward/risk < 0.8
 */
export function evaluateRangeSetup(
  m15Candles: BacktestCandle[],
  m15Indicators: IndicatorState,
  h1Candles: BacktestCandle[],
  h1Indicators: IndicatorState,
  idx: number,
  spread: number,
  minAtr: number,
  pricePrecision: number,
): SetupSignal | null {
  if (idx < 50) return null;

  const candle = m15Candles[idx];
  const ema50 = m15Indicators.ema50[idx];
  const rsi = m15Indicators.rsi14[idx];
  const atr = m15Indicators.atr14[idx];

  if (isNaN(ema50) || isNaN(rsi) || isNaN(atr) || atr === 0) return null;
  if (atr < minAtr) return null;

  // V4: HIGH_VOLATILITY filter
  const atrBaseline = m15Indicators.atrBaseline[idx];
  if (!isNaN(atrBaseline) && atrBaseline > 0 && atr / atrBaseline >= 1.6) return null;

  // Session filter (same as trend)
  if (!isActiveTradingSession(candle.openTime)) return null;

  // Must be ranging (ADX < 20)
  const { h1Adx } = getH1Regime(h1Candles, h1Indicators, candle.openTime);
  if (h1Adx >= 20) return null;

  // ATR bands around EMA50
  const upperBand = ema50 + atr * 1.5;
  const lowerBand = ema50 - atr * 1.5;
  const halfSpread = spread / 2;

  let side: 'BUY' | 'SELL' | null = null;

  // BUY: price at lower extreme, RSI oversold, bullish candle
  if (candle.low <= lowerBand && rsi < 30 && candle.close > candle.open) {
    side = 'BUY';
  }
  // SELL: price at upper extreme, RSI overbought, bearish candle
  else if (candle.high >= upperBand && rsi > 70 && candle.close < candle.open) {
    side = 'SELL';
  }
  if (!side) return null;

  // Confirmation pattern (reuse existing detectors)
  const hasEngulfing = detectEngulfing(m15Candles, idx);
  const hasStrongClose = detectStrongClose(m15Candles, idx);
  const hasPinBar = detectPinBar(m15Candles, idx, side);
  if (!hasEngulfing && !hasStrongClose && !hasPinBar) return null;

  // Spread-adjusted entry
  const entryPrice = side === 'BUY'
    ? candle.close + halfSpread
    : candle.close - halfSpread;

  // SL: beyond band + ATR buffer
  let slPrice = side === 'BUY'
    ? lowerBand - atr * 0.5
    : upperBand + atr * 0.5;

  // Clamp SL distance
  const slDistance = Math.abs(entryPrice - slPrice);
  if (slDistance < atr * 0.5) {
    slPrice = side === 'BUY' ? entryPrice - atr * 0.5 : entryPrice + atr * 0.5;
  }
  if (slDistance > atr * 2.0) {
    slPrice = side === 'BUY' ? entryPrice - atr * 2.0 : entryPrice + atr * 2.0;
  }

  // TP: mean reversion to EMA50 (midline)
  const tpPrice = ema50;

  // R:R gate — skip if reward too low
  const risk = Math.abs(entryPrice - slPrice);
  const reward = Math.abs(tpPrice - entryPrice);
  if (risk === 0 || reward / risk < 0.8) return null;

  const tags: string[] = ['RANGE_ENGINE', 'MEAN_REVERSION'];
  if (hasEngulfing) tags.push('ENGULFING');
  if (hasStrongClose) tags.push('STRONG_CLOSE');
  if (hasPinBar) tags.push('PIN_BAR');
  tags.push(side === 'BUY' ? 'RSI_OVERSOLD' : 'RSI_OVERBOUGHT');

  const factor = Math.pow(10, pricePrecision);

  return {
    side,
    entryPrice: Math.round(entryPrice * factor) / factor,
    slPrice: Math.round(slPrice * factor) / factor,
    tpPrice: Math.round(tpPrice * factor) / factor,
    setupTags: tags,
    h1Bias: 'NEUTRAL',
    rsiAtEntry: Math.round(rsi * 100) / 100,
    atrAtEntry: Math.round(atr * 100000) / 100000,
  };
}
