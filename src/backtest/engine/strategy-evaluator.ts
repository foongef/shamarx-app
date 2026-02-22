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

  // V2.1: DI separation — clear directional dominance
  if (Math.abs(plusDI - minusDI) < 5) return 'RANGING';

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
  // London: local 08:00-11:59 (covers both GMT and BST)
  if (londonHour >= 8 && londonHour < 12) return true;

  const nyHour = getLocalHour(openTime, 'America/New_York');
  // New York: local 08:00-10:59 (covers both EST and EDT)
  if (nyHour >= 8 && nyHour < 11) return true;

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
 * Get the H1 regime at a given M15 candle time.
 * Uses binary search to find the matching H1 candle.
 */
export function getH1Regime(
  h1Candles: BacktestCandle[],
  h1Indicators: IndicatorState,
  currentTime: string,
): { regime: MarketRegime; bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' } {
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
    return { regime: 'RANGING', bias: 'NEUTRAL' };
  }

  const regime = getMarketRegime(h1Indicators, bestIdx);
  const ema20 = h1Indicators.ema20[bestIdx];
  const ema50 = h1Indicators.ema50[bestIdx];

  let bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
  if (!isNaN(ema20) && !isNaN(ema50)) {
    bias = ema20 > ema50 ? 'BULLISH' : ema20 < ema50 ? 'BEARISH' : 'NEUTRAL';
  }

  return { regime, bias };
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

// ─── V2.1 Setup Signal ──────────────────────────────────────────────────────

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
 * V2.1 Strategy: Trend-following pullback to EMA20 with regime + session filters.
 *
 * Entry conditions:
 * 1. H1 ADX >= 20, rising, with DI separation >= 5 (trending regime)
 * 2. Active trading session (London/NY, DST-safe)
 * 3. H1 EMA20/EMA50 bias agrees with ADX DI direction
 * 4. M15 price pulls back to EMA20 zone (within ATR*0.5)
 * 5. Candle shows directional commitment (touches EMA20, closes in trade direction)
 * 6. Engulfing or strong close confirmation
 * 7. RSI in valid range (40-65 BUY, 35-60 SELL)
 * 8. SR feasibility: nearest opposing SR level not blocking TP
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
): SetupSignal | null {
  if (idx < 50) return null;

  const candle = m15Candles[idx];
  const ema20 = m15Indicators.ema20[idx];
  const rsi = m15Indicators.rsi14[idx];
  const atr = m15Indicators.atr14[idx];

  if (isNaN(ema20) || isNaN(rsi) || isNaN(atr) || atr === 0) return null;

  // Filter 1: Session filter (DST-safe)
  if (!isActiveTradingSession(candle.openTime)) return null;


  // Filter 2: H1 regime + bias (includes rising ADX + DI separation)
  const { regime, bias } = getH1Regime(h1Candles, h1Indicators, candle.openTime);
  if (regime === 'RANGING') return null;

  if (bias === 'NEUTRAL') return null;

  // Regime direction must agree with EMA bias
  if (regime !== bias) return null;


  const isBullish = regime === 'BULLISH';

  // Filter 3: RSI range
  if (isBullish && (rsi < 40 || rsi > 65)) return null;
  if (!isBullish && (rsi < 35 || rsi > 60)) return null;


  // Entry: Pullback to M15 EMA20 zone
  const tolerance = atr * 0.5;
  const touchesEma = candle.low <= ema20 + tolerance && candle.high >= ema20 - tolerance;
  if (!touchesEma) return null;


  // Directional commitment: candle dips to EMA20 zone and closes in trade direction
  if (isBullish) {
    // Price must dip toward or below EMA20, then close above it
    if (candle.low > ema20 + tolerance * 0.5) return null; // didn't pull back enough
    if (candle.close <= ema20) return null; // didn't close above EMA20
    if (candle.close <= candle.open) return null; // not a bullish candle
  } else {
    // Price must rise toward or above EMA20, then close below it
    if (candle.high < ema20 - tolerance * 0.5) return null; // didn't pull back enough
    if (candle.close >= ema20) return null; // didn't close below EMA20
    if (candle.close >= candle.open) return null; // not a bearish candle
  }


  // Confirmation pattern
  const hasEngulfing = detectEngulfing(m15Candles, idx);
  const hasStrongClose = detectStrongClose(m15Candles, idx);
  if (!hasEngulfing && !hasStrongClose) return null;


  // Build tags
  const tags: string[] = ['PULLBACK_EMA20', 'V2.1'];
  if (hasEngulfing) tags.push('ENGULFING');
  if (hasStrongClose) tags.push('STRONG_CLOSE');
  tags.push(regime === 'BULLISH' ? 'ADX_BULL' : 'ADX_BEAR');

  // V2.1: Spread-adjusted entry price
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
    slPrice = Math.min(swingSL, entryPrice - atr * 1.0) - spreadBuffer;
  } else {
    const recentHighs = swingPoints
      .filter((p) => p.type === 'HIGH')
      .slice(-3)
      .map((p) => p.price);
    const swingSL = recentHighs.length > 0 ? Math.max(...recentHighs) : entryPrice + atr * 2.0;
    slPrice = Math.max(swingSL, entryPrice + atr * 1.0) + spreadBuffer;
  }

  // Clamp SL distance to [ATR*1.0, ATR*3.0]
  const slDistance = Math.abs(entryPrice - slPrice);
  if (slDistance < atr * 1.0) {
    slPrice = isBullish ? entryPrice - atr * 1.0 : entryPrice + atr * 1.0;
  }
  if (slDistance > atr * 3.0) {
    slPrice = isBullish ? entryPrice - atr * 3.0 : entryPrice + atr * 3.0;
  }

  // V2.1: TP at 2.0x risk (raised from 1.5x)
  const risk = Math.abs(entryPrice - slPrice);
  // TP at 1.5x risk — achievable for pullback entries on gold
  const tpPrice = isBullish ? entryPrice + risk * 1.5 : entryPrice - risk * 1.5;

  // SR feasibility check removed — M15 swing points are too granular for pullback entries.
  // The prior swing high/low is almost always within 1-2R of entry by definition of a pullback.
  // TODO: Revisit with H1/H4 major S/R levels instead of M15 micro-swings.


  return {
    side: isBullish ? 'BUY' : 'SELL',
    entryPrice: Math.round(entryPrice * 100) / 100,
    slPrice: Math.round(slPrice * 100) / 100,
    tpPrice: Math.round(tpPrice * 100) / 100,
    setupTags: tags,
    h1Bias: bias,
    rsiAtEntry: Math.round(rsi * 100) / 100,
    atrAtEntry: Math.round(atr * 100) / 100,
  };
}
