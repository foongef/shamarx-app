import {
  BacktestCandle,
  IndicatorState,
  SwingPoint,
  SwingPointTracker,
  BOSLevel,
  FairValueGap,
  SetupType,
  DetailedRegime,
  RegimeState,
  RegimeTradeParams,
} from './types';
import { PerformanceTracker } from './performance-tracker';

// ─── V6: Regime State Machine ────────────────────────────────────────────────

// Hysteresis thresholds — prevents regime flapping
const STRONG_TREND_ENTER_ADX = 25;
const STRONG_TREND_EXIT_ADX = 23;
const WEAK_TREND_ENTER_ADX = 15;
const WEAK_TREND_EXIT_ADX = 13;
const VOLATILE_ATR_ENTER = 1.8;
const VOLATILE_ATR_EXIT = 1.5;
const MIN_REGIME_DURATION = 2; // bars before regime change takes effect

export type MarketRegime = 'BULLISH' | 'BEARISH' | 'RANGING';

/**
 * V6: Detect detailed regime with hysteresis and state memory.
 * Replaces the simple getMarketRegime + getH1Regime approach.
 */
export function detectRegime(
  h1Candles: BacktestCandle[],
  h1Indicators: IndicatorState,
  currentTime: string,
  prevState: RegimeState | null,
  tracker?: PerformanceTracker,
): RegimeState {
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
    return {
      regime: 'RANGING',
      direction: 'NEUTRAL',
      durationBars: 0,
      adx: 0,
      adxSlope: 0,
      diSeparation: 0,
      atrRatio: 1,
      emaStackAligned: false,
      h1Idx: -1,
    };
  }

  const adx = h1Indicators.adx14[bestIdx];
  const plusDI = h1Indicators.plusDI14[bestIdx];
  const minusDI = h1Indicators.minusDI14[bestIdx];
  const ema20 = h1Indicators.ema20[bestIdx];
  const ema50 = h1Indicators.ema50[bestIdx];
  const ema200 = h1Indicators.ema200[bestIdx];
  const atr = h1Indicators.atr14[bestIdx];
  const atrBaseline = h1Indicators.atrBaseline[bestIdx];

  // ADX slope: 3-bar lookback
  const adxPrev = bestIdx >= 3 ? h1Indicators.adx14[bestIdx - 3] : NaN;
  const adxSlope = !isNaN(adxPrev) && !isNaN(adx) ? adx - adxPrev : 0;

  // DI separation
  const diSep = !isNaN(plusDI) && !isNaN(minusDI) ? Math.abs(plusDI - minusDI) : 0;

  // ATR ratio
  const atrRatio = (!isNaN(atr) && !isNaN(atrBaseline) && atrBaseline > 0) ? atr / atrBaseline : 1;

  // EMA stack alignment
  const emaStackAligned = !isNaN(ema20) && !isNaN(ema50) && !isNaN(ema200) &&
    ((ema20 > ema50 && ema50 > ema200) || (ema20 < ema50 && ema50 < ema200));

  // Direction from DI
  let direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
  if (!isNaN(plusDI) && !isNaN(minusDI) && diSep >= 3) {
    direction = plusDI > minusDI ? 'BULLISH' : 'BEARISH';
  }

  // H1 EMA bias for direction confirmation
  if (direction !== 'NEUTRAL' && !isNaN(ema20) && !isNaN(ema50)) {
    const emaBias = ema20 > ema50 ? 'BULLISH' : ema20 < ema50 ? 'BEARISH' : 'NEUTRAL';
    // If EMA disagrees with DI, downgrade direction
    if (emaBias !== 'NEUTRAL' && emaBias !== direction) {
      direction = 'NEUTRAL';
    }
  }

  // Classify raw regime (before hysteresis)
  let rawRegime: DetailedRegime;
  const safeAdx = isNaN(adx) ? 0 : adx;

  if (atrRatio >= VOLATILE_ATR_ENTER) {
    rawRegime = 'VOLATILE';
  } else if (safeAdx >= STRONG_TREND_ENTER_ADX && diSep >= 5) {
    rawRegime = 'STRONG_TREND';
  } else if (safeAdx >= WEAK_TREND_ENTER_ADX && diSep >= 3) {
    rawRegime = 'WEAK_TREND';
  } else if (safeAdx < WEAK_TREND_ENTER_ADX || diSep < 3) {
    rawRegime = 'RANGING';
  } else {
    rawRegime = 'TRANSITIONING';
  }

  // Apply hysteresis — don't change regime unless exit threshold crossed
  let finalRegime = rawRegime;
  let durationBars = 1;

  if (prevState && prevState.h1Idx !== bestIdx) {
    // Same H1 bar = no update
    const prevRegime = prevState.regime;
    durationBars = prevState.durationBars + 1;

    if (prevRegime === rawRegime) {
      finalRegime = prevRegime;
    } else {
      // Check if exit threshold crossed
      let shouldSwitch = false;

      if (prevRegime === 'STRONG_TREND') {
        shouldSwitch = safeAdx < STRONG_TREND_EXIT_ADX || diSep < 3 || atrRatio >= VOLATILE_ATR_ENTER;
      } else if (prevRegime === 'WEAK_TREND') {
        shouldSwitch = safeAdx < WEAK_TREND_EXIT_ADX || diSep < 2 ||
          safeAdx >= STRONG_TREND_ENTER_ADX || atrRatio >= VOLATILE_ATR_ENTER;
      } else if (prevRegime === 'RANGING') {
        shouldSwitch = safeAdx >= WEAK_TREND_ENTER_ADX && diSep >= 3;
        if (atrRatio >= VOLATILE_ATR_ENTER) shouldSwitch = true;
      } else if (prevRegime === 'VOLATILE') {
        shouldSwitch = atrRatio < VOLATILE_ATR_EXIT;
      } else if (prevRegime === 'TRANSITIONING') {
        shouldSwitch = durationBars >= MIN_REGIME_DURATION;
      }

      if (shouldSwitch) {
        finalRegime = rawRegime;
        durationBars = 1; // reset duration on regime change
      } else {
        finalRegime = prevRegime;
      }
    }
  }

  // Performance tracker feedback: if WEAK_TREND engine is losing, bias toward RANGING
  if (finalRegime === 'WEAK_TREND' && tracker) {
    const trendConf = tracker.getEngineConfidence('TREND_PULLBACK');
    if (trendConf < 30) {
      finalRegime = 'RANGING';
      durationBars = 1;
    }
  }

  return {
    regime: finalRegime,
    direction,
    durationBars,
    adx: safeAdx,
    adxSlope,
    diSeparation: diSep,
    atrRatio,
    emaStackAligned,
    h1Idx: bestIdx,
  };
}

// ─── V6: Regime Trade Parameters ─────────────────────────────────────────────

export function getRegimeParams(regime: DetailedRegime): RegimeTradeParams {
  switch (regime) {
    case 'STRONG_TREND':
      return { trendTpR: 2.5, fvgTpR: 1.5, beThresholdR: 1.0, tpRemovalR: 2.0, slClampMaxAtr: 3.0 };
    case 'WEAK_TREND':
      return { trendTpR: 1.5, fvgTpR: 1.0, beThresholdR: 0.8, tpRemovalR: 1.5, slClampMaxAtr: 2.5 };
    case 'RANGING':
      return { trendTpR: 1.0, fvgTpR: 1.0, beThresholdR: 0.6, tpRemovalR: 0, slClampMaxAtr: 2.0 };
    case 'VOLATILE':
      return { trendTpR: 1.0, fvgTpR: 0.8, beThresholdR: 0.5, tpRemovalR: 0, slClampMaxAtr: 1.5 };
    case 'TRANSITIONING':
      return { trendTpR: 1.5, fvgTpR: 1.0, beThresholdR: 0.8, tpRemovalR: 1.5, slClampMaxAtr: 2.0 };
  }
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
  if (londonHour >= 8 && londonHour < 17) return true;

  const nyHour = getLocalHour(openTime, 'America/New_York');
  if (nyHour >= 8 && nyHour < 14) return true;

  return false;
}

// ─── V6: D1 Trend Confluence ────────────────────────────────────────────────

/**
 * D1 trend bias derived from EMA50 slope + close-vs-EMA50 confluence.
 *
 * V6 hysteresis: when 5-bar EMA50 slope is < 0.3% of price (sideways D1),
 * we return NEUTRAL even if close-vs-EMA agrees. This prevents counter-D1
 * penalties during D1 consolidation phases (e.g. multi-week ranges).
 */
export function getD1Bias(
  d1Candles: BacktestCandle[],
  d1Indicators: IndicatorState,
  currentTime: string,
): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
  if (d1Candles.length === 0) return 'NEUTRAL';

  const target = new Date(currentTime).getTime();
  let lo = 0;
  let hi = d1Candles.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (new Date(d1Candles[mid].openTime).getTime() <= target) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (idx < 5) return 'NEUTRAL';

  const ema50 = d1Indicators.ema50[idx];
  const ema50Prev = d1Indicators.ema50[idx - 5];
  const close = d1Candles[idx].close;
  if (isNaN(ema50) || isNaN(ema50Prev)) return 'NEUTRAL';

  const slope = ema50 - ema50Prev;
  // Hysteresis: treat near-flat D1 as NEUTRAL.
  // Threshold: |slope| / price >= 0.3% over 5 D1 bars.
  const slopePct = Math.abs(slope) / Math.max(1, close);
  if (slopePct < 0.003) return 'NEUTRAL';

  const above = close > ema50;
  if (slope > 0 && above) return 'BULLISH';
  if (slope < 0 && !above) return 'BEARISH';
  return 'NEUTRAL';
}

// ─── H1 Trend Confirmation ──────────────────────────────────────────────────

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

  if (ema20 > ema50) return 'BULLISH';
  if (ema20 < ema50) return 'BEARISH';
  return 'NEUTRAL';
}

/**
 * V2.8: Check if H1 regime has been stable for last N bars.
 * V6: Returns stability count for quality scoring (0 = unstable, 1+ = stable bars).
 */
export function getH1RegimeStabilityCount(
  h1Candles: BacktestCandle[],
  h1Indicators: IndicatorState,
  currentTime: string,
  maxLookback: number = 5,
): number {
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

  if (bestIdx < 1) return 0;

  const currentRegime = getMarketRegimeSimple(h1Indicators, bestIdx);
  let stableCount = 0;
  for (let k = 1; k <= maxLookback && bestIdx - k >= 0; k++) {
    if (getMarketRegimeSimple(h1Indicators, bestIdx - k) === currentRegime) {
      stableCount++;
    } else {
      break;
    }
  }
  return stableCount;
}

// Kept for stability check compatibility
function getMarketRegimeSimple(h1Indicators: IndicatorState, h1Idx: number): string {
  const adx = h1Indicators.adx14[h1Idx];
  const plusDI = h1Indicators.plusDI14[h1Idx];
  const minusDI = h1Indicators.minusDI14[h1Idx];

  if (isNaN(adx) || isNaN(plusDI) || isNaN(minusDI)) return 'RANGING';
  if (adx < 20) return 'RANGING';
  if (Math.abs(plusDI - minusDI) < 3) return 'RANGING';
  return plusDI > minusDI ? 'BULLISH' : 'BEARISH';
}

/**
 * Legacy getH1Regime — still used by FVG/Range engines for h1Adx access.
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

  const adx = h1Indicators.adx14[bestIdx];
  const plusDI = h1Indicators.plusDI14[bestIdx];
  const minusDI = h1Indicators.minusDI14[bestIdx];
  const ema20 = h1Indicators.ema20[bestIdx];
  const ema50 = h1Indicators.ema50[bestIdx];
  const h1Adx = isNaN(adx) ? 0 : adx;

  let regime: MarketRegime = 'RANGING';
  if (!isNaN(adx) && !isNaN(plusDI) && !isNaN(minusDI) && adx >= 20 && Math.abs(plusDI - minusDI) >= 3) {
    regime = plusDI > minusDI ? 'BULLISH' : 'BEARISH';
  }

  let bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
  if (!isNaN(ema20) && !isNaN(ema50)) {
    bias = ema20 > ema50 ? 'BULLISH' : ema20 < ema50 ? 'BEARISH' : 'NEUTRAL';
  }

  const adxPrev = bestIdx >= 2 ? h1Indicators.adx14[bestIdx - 2] : NaN;
  const adxRising = !isNaN(adxPrev) && h1Adx > adxPrev;

  return { regime, bias, h1Adx, adxRising };
}

// ─── Swing Points ───────────────────────────────────────────────────────────

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

// ─── Confirmation Patterns ──────────────────────────────────────────────────

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
  // V6 (round 3): loosened from 0.6 / 0.75 to 0.5 / 0.65 — captures more
  // valid trend-continuation bars without admitting too many wicks.
  if (bodyRatio < 0.5) return false;

  const isBullish = curr.close > curr.open;
  if (isBullish) {
    return (curr.close - curr.low) / range >= 0.65;
  } else {
    return (curr.high - curr.close) / range >= 0.65;
  }
}

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
  if (bodyRatio > 0.4) return false;

  const upperWick = curr.high - Math.max(curr.open, curr.close);
  const lowerWick = Math.min(curr.open, curr.close) - curr.low;

  if (side === 'BUY') {
    return lowerWick / range >= 0.6 && upperWick / range <= 0.25;
  } else {
    return upperWick / range >= 0.6 && lowerWick / range <= 0.25;
  }
}

// ─── V6 Setup Signal ─────────────────────────────────────────────────────────

export interface SetupSignal {
  side: 'BUY' | 'SELL';
  entryPrice: number;
  slPrice: number;
  tpPrice: number;
  setupTags: string[];
  h1Bias: string;
  rsiAtEntry: number;
  atrAtEntry: number;
  setupType?: SetupType;
  qualityScore?: number;
  regimeTradeParams?: RegimeTradeParams;
}

// ─── V6: Continuous Quality Scoring for Trend Engine ─────────────────────────

/**
 * V6: Trend-following pullback with continuous quality scoring.
 * Binary filters replaced with quality penalties. Hard rejects preserved for tier-1 filters.
 *
 * minQuality: minimum quality threshold (default 35, lowered by weekly floor)
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
  regimeState: RegimeState,
  minQuality: number = 35,
): SetupSignal | null {
  // === TIER-1 HARD REJECTS (never soften) ===
  if (idx < 50) return null;

  const candle = m15Candles[idx];
  const ema20 = m15Indicators.ema20[idx];
  const ema50 = m15Indicators.ema50[idx];
  const rsi = m15Indicators.rsi14[idx];
  const atr = m15Indicators.atr14[idx];

  if (isNaN(ema20) || isNaN(ema50) || isNaN(rsi) || isNaN(atr) || atr === 0) return null;

  // Hard reject: minimum volatility
  if (atr < minAtr) return null;

  // Hard reject: extreme volatility (ATR > 2.0x baseline)
  const atrBaseline = m15Indicators.atrBaseline[idx];
  if (!isNaN(atrBaseline) && atrBaseline > 0 && atr / atrBaseline >= 2.0) return null;

  // Hard reject: session filter
  if (!isActiveTradingSession(candle.openTime)) return null;

  // Hard reject: ADX < 15 (no trend signal at all)
  // V6 (round 3): ADX floor 15 → 12 to capture early-trend setups
  if (regimeState.adx < 12) return null;

  // RSI hard reject: keep original tight window (35-70 BUY / 30-65 SELL).
  // Round-3 widening dropped 2025 win rate 69→46%, so reverted.
  const direction = regimeState.direction;
  if (direction === 'NEUTRAL') return null;
  const isBullish = direction === 'BULLISH';
  if (isBullish && (rsi < 35 || rsi > 70)) return null;
  if (!isBullish && (rsi < 30 || rsi > 65)) return null;

  // === QUALITY SCORING (continuous, replaces binary gates) ===
  let quality = 60; // base quality

  // ADX level penalty (was: ADX < 25 → reject)
  if (regimeState.adx >= 30) quality += 10;
  else if (regimeState.adx >= 25) quality += 0;
  else if (regimeState.adx >= 20) quality -= 10;
  else quality -= 20; // ADX 15-20

  // ADX slope penalty (was: !adxRising → reject)
  if (regimeState.adxSlope > 2) quality += 5;
  else if (regimeState.adxSlope > 0) quality += 0;
  else if (regimeState.adxSlope > -2) quality -= 8; // flat-ish
  else quality -= 15; // falling

  // Regime stability penalty (was: !stable → reject)
  const stabilityBars = getH1RegimeStabilityCount(h1Candles, h1Indicators, candle.openTime);
  if (stabilityBars >= 3) quality += 5;
  else if (stabilityBars >= 2) quality += 0;
  else quality -= 10; // unstable

  // ATR/baseline ratio penalty (was: >= 1.6 → reject)
  const atrRatio = (!isNaN(atrBaseline) && atrBaseline > 0) ? atr / atrBaseline : 1.0;
  if (atrRatio >= 1.6) quality -= 15; // elevated but not extreme
  else if (atrRatio >= 1.3) quality -= 5;
  else if (atrRatio >= 0.8 && atrRatio <= 1.3) quality += 5; // healthy range

  // RSI alignment penalty (was: strict range → reject)
  if (isBullish) {
    if (rsi >= 40 && rsi <= 60) quality += 5;
    else if (rsi >= 35 && rsi < 40) quality -= 8; // marginal
    else if (rsi > 60 && rsi <= 65) quality -= 5;
    else quality -= 8; // 65-70 zone
  } else {
    if (rsi >= 40 && rsi <= 60) quality += 5;
    else if (rsi > 60 && rsi <= 65) quality -= 8;
    else if (rsi >= 35 && rsi < 40) quality -= 5;
    else quality -= 8; // 30-35 zone
  }

  // DI separation quality
  if (regimeState.diSeparation >= 10) quality += 5;
  else if (regimeState.diSeparation < 5) quality -= 5;

  // EMA stack alignment bonus
  if (regimeState.emaStackAligned) quality += 5;

  // Regime-specific boost
  if (regimeState.regime === 'STRONG_TREND') quality += 10;
  else if (regimeState.regime === 'WEAK_TREND') quality -= 5;
  else if (regimeState.regime === 'TRANSITIONING') quality -= 10;

  // Regime bias must agree with trade direction
  if (regimeState.regime !== 'RANGING' && regimeState.regime !== 'VOLATILE') {
    const h1Bias = getH1Bias(h1Candles, h1Indicators, candle.openTime);
    if (h1Bias === 'NEUTRAL') quality -= 10;
    else if ((isBullish && h1Bias !== 'BULLISH') || (!isBullish && h1Bias !== 'BEARISH')) {
      return null; // Hard reject: H1 bias opposes trade
    }
  }

  // === REJECT IF QUALITY TOO LOW ===
  if (quality < minQuality) return null;

  // V2.6: EMA20 slope — must be trending in trade direction
  if (idx >= 4) {
    const ema20Prev = m15Indicators.ema20[idx - 4];
    if (!isNaN(ema20Prev)) {
      if (isBullish && ema20 <= ema20Prev) quality -= 10;
      if (!isBullish && ema20 >= ema20Prev) quality -= 10;
    }
  }

  // Re-check after EMA slope penalty
  if (quality < minQuality) return null;

  // Determine pullback target
  const ema20Tolerance = atr * 0.6;
  const touchesEma20 = candle.low <= ema20 + ema20Tolerance && candle.high >= ema20 - ema20Tolerance;

  let pullbackTarget: 'EMA20' | 'EMA50' = 'EMA20';
  let pullbackEma = ema20;
  let pullbackTolerance = ema20Tolerance;

  if (!touchesEma20) {
    // EMA50 pullback: only for ADX >= 20
    if (regimeState.adx < 20) return null;

    const ema50Tolerance = atr * 0.75;
    const touchesEma50 = candle.low <= ema50 + ema50Tolerance && candle.high >= ema50 - ema50Tolerance;
    const emaSeparation = Math.abs(ema20 - ema50);

    if (touchesEma50 && emaSeparation >= atr * 0.5) {
      pullbackTarget = 'EMA50';
      pullbackEma = ema50;
      pullbackTolerance = ema50Tolerance;
    } else {
      return null;
    }
  }

  // Directional commitment
  if (isBullish) {
    if (candle.low > pullbackEma + pullbackTolerance * 0.5) return null;
    if (candle.close <= pullbackEma) return null;
    if (candle.close <= candle.open) return null;
  } else {
    if (candle.high < pullbackEma - pullbackTolerance * 0.5) return null;
    if (candle.close >= pullbackEma) return null;
    if (candle.close >= candle.open) return null;
  }

  if (pullbackTarget === 'EMA50') {
    if (isBullish && candle.close <= ema50) return null;
    if (!isBullish && candle.close >= ema50) return null;
  }

  // Confirmation pattern
  const hasEngulfing = detectEngulfing(m15Candles, idx);
  const hasStrongClose = detectStrongClose(m15Candles, idx);
  if (!hasEngulfing && !hasStrongClose) return null;

  // Confirmation quality bonus
  if (hasEngulfing) quality += 5;
  if (hasStrongClose) quality += 3;

  // Session quality bonus
  const londonHour = getLocalHour(candle.openTime, 'Europe/London');
  const nyHour = getLocalHour(candle.openTime, 'America/New_York');
  if (londonHour >= 13 && londonHour < 17 && nyHour >= 8 && nyHour < 12) {
    quality += 7; // London-NY overlap
  } else if (londonHour >= 8 && londonHour < 13) {
    quality += 3;
  }

  // Build tags
  const regimeParams = getRegimeParams(regimeState.regime);
  const tags: string[] = [
    pullbackTarget === 'EMA50' ? 'PULLBACK_EMA50' : 'PULLBACK_EMA20',
    'V6.0',
    regimeState.regime,
  ];
  if (hasEngulfing) tags.push('ENGULFING');
  if (hasStrongClose) tags.push('STRONG_CLOSE');
  tags.push(isBullish ? 'ADX_BULL' : 'ADX_BEAR');

  // Spread-adjusted entry price
  const halfSpread = spread / 2;
  const entryPrice = isBullish
    ? candle.close + halfSpread
    : candle.close - halfSpread;

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

  // V6: Regime-adaptive SL clamp
  const slClampMax = atr * regimeParams.slClampMaxAtr;
  const slDistance = Math.abs(entryPrice - slPrice);
  if (slDistance < atr * 1.0) {
    slPrice = isBullish ? entryPrice - atr * 1.0 : entryPrice + atr * 1.0;
  }
  if (slDistance > slClampMax) {
    slPrice = isBullish ? entryPrice - slClampMax : entryPrice + slClampMax;
  }

  // V6: Regime-adaptive TP
  const risk = Math.abs(entryPrice - slPrice);
  const tpPrice = isBullish ? entryPrice + risk * regimeParams.trendTpR : entryPrice - risk * regimeParams.trendTpR;

  const factor = Math.pow(10, pricePrecision);

  return {
    side: isBullish ? 'BUY' : 'SELL',
    entryPrice: Math.round(entryPrice * factor) / factor,
    slPrice: Math.round(slPrice * factor) / factor,
    tpPrice: Math.round(tpPrice * factor) / factor,
    setupTags: tags,
    h1Bias: regimeState.direction,
    rsiAtEntry: Math.round(rsi * 100) / 100,
    atrAtEntry: Math.round(atr * 100000) / 100000,
    setupType: 'TREND_PULLBACK',
    qualityScore: quality,
    regimeTradeParams: regimeParams,
  };
}

// ─── V6: Range Engine (with quality scoring) ─────────────────────────────────

export function evaluateRangeSetup(
  m15Candles: BacktestCandle[],
  m15Indicators: IndicatorState,
  _h1Candles: BacktestCandle[],
  _h1Indicators: IndicatorState,
  idx: number,
  spread: number,
  minAtr: number,
  pricePrecision: number,
  regimeState: RegimeState,
  minQuality: number = 35,
): SetupSignal | null {
  if (idx < 50) return null;

  const candle = m15Candles[idx];
  const ema50 = m15Indicators.ema50[idx];
  const rsi = m15Indicators.rsi14[idx];
  const atr = m15Indicators.atr14[idx];

  if (isNaN(ema50) || isNaN(rsi) || isNaN(atr) || atr === 0) return null;
  if (atr < minAtr) return null;

  // Hard reject: extreme volatility
  const atrBaseline = m15Indicators.atrBaseline[idx];
  if (!isNaN(atrBaseline) && atrBaseline > 0 && atr / atrBaseline >= 2.0) return null;

  if (!isActiveTradingSession(candle.openTime)) return null;

  // Must be ranging (use regime state)
  if (regimeState.regime !== 'RANGING' && regimeState.regime !== 'TRANSITIONING') return null;
  if (regimeState.adx >= 20) return null;

  // ATR bands around EMA50
  const upperBand = ema50 + atr * 1.5;
  const lowerBand = ema50 - atr * 1.5;
  const halfSpread = spread / 2;

  let side: 'BUY' | 'SELL' | null = null;

  if (candle.low <= lowerBand && rsi < 30 && candle.close > candle.open) {
    side = 'BUY';
  } else if (candle.high >= upperBand && rsi > 70 && candle.close < candle.open) {
    side = 'SELL';
  }
  if (!side) return null;

  // Confirmation pattern
  const hasEngulfing = detectEngulfing(m15Candles, idx);
  const hasStrongClose = detectStrongClose(m15Candles, idx);
  const hasPinBar = detectPinBar(m15Candles, idx, side);
  if (!hasEngulfing && !hasStrongClose && !hasPinBar) return null;

  // Quality scoring for range
  let quality = 50;
  if (hasEngulfing) quality += 5;
  if (hasStrongClose) quality += 3;
  if (hasPinBar) quality += 5;
  if (rsi < 25 || rsi > 75) quality += 5; // extreme RSI = stronger mean reversion signal
  if (regimeState.durationBars >= 3) quality += 5; // stable range

  if (quality < minQuality) return null;

  const entryPrice = side === 'BUY'
    ? candle.close + halfSpread
    : candle.close - halfSpread;

  let slPrice = side === 'BUY'
    ? lowerBand - atr * 0.5
    : upperBand + atr * 0.5;

  const slDistance = Math.abs(entryPrice - slPrice);
  if (slDistance < atr * 0.5) {
    slPrice = side === 'BUY' ? entryPrice - atr * 0.5 : entryPrice + atr * 0.5;
  }
  if (slDistance > atr * 2.0) {
    slPrice = side === 'BUY' ? entryPrice - atr * 2.0 : entryPrice + atr * 2.0;
  }

  const tpPrice = ema50;

  const risk = Math.abs(entryPrice - slPrice);
  const reward = Math.abs(tpPrice - entryPrice);
  if (risk === 0 || reward / risk < 0.8) return null;

  const regimeParams = getRegimeParams('RANGING');
  const tags: string[] = ['RANGE_ENGINE', 'MEAN_REVERSION', 'V6.0'];
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
    setupType: 'RANGE_REVERSION',
    qualityScore: quality,
    regimeTradeParams: regimeParams,
  };
}

// ─── V5: Swing Point Tracker ─────────────────────────────────────────────────

export function updateSwingTracker(
  tracker: SwingPointTracker,
  candles: BacktestCandle[],
  idx: number,
  lookback: number = 5,
): void {
  const candidateIdx = idx - lookback;
  if (candidateIdx < lookback || candidateIdx >= candles.length) return;

  const candidate = candles[candidateIdx];

  let isHigh = true;
  let isLow = true;
  for (let j = 1; j <= lookback; j++) {
    const before = candidateIdx - j;
    const after = candidateIdx + j;
    if (before < 0 || after >= candles.length) {
      isHigh = false;
      isLow = false;
      break;
    }
    if (candles[before].high >= candidate.high || candles[after].high >= candidate.high) {
      isHigh = false;
    }
    if (candles[before].low <= candidate.low || candles[after].low <= candidate.low) {
      isLow = false;
    }
  }

  if (isHigh) {
    tracker.recentHighs.push({ index: candidateIdx, price: candidate.high, type: 'HIGH' });
    if (tracker.recentHighs.length > 20) tracker.recentHighs.shift();
  }
  if (isLow) {
    tracker.recentLows.push({ index: candidateIdx, price: candidate.low, type: 'LOW' });
    if (tracker.recentLows.length > 20) tracker.recentLows.shift();
  }
}

// ─── V5: BOS Detection ──────────────────────────────────────────────────────

export function detectBOSEvents(
  candles: BacktestCandle[],
  idx: number,
  tracker: SwingPointTracker,
  existingLevels: BOSLevel[],
): BOSLevel[] {
  const newLevels: BOSLevel[] = [];
  const candle = candles[idx];

  for (const swingHigh of tracker.recentHighs) {
    if (candle.close > swingHigh.price) {
      const alreadyTracked = existingLevels.some(
        (l) => l.direction === 'BUY' && Math.abs(l.brokenLevel - swingHigh.price) < 0.01,
      );
      if (!alreadyTracked) {
        newLevels.push({
          direction: 'BUY',
          brokenLevel: swingHigh.price,
          breakIndex: idx,
          traded: false,
          expiryCandles: 48,
        });
      }
    }
  }

  for (const swingLow of tracker.recentLows) {
    if (candle.close < swingLow.price) {
      const alreadyTracked = existingLevels.some(
        (l) => l.direction === 'SELL' && Math.abs(l.brokenLevel - swingLow.price) < 0.01,
      );
      if (!alreadyTracked) {
        newLevels.push({
          direction: 'SELL',
          brokenLevel: swingLow.price,
          breakIndex: idx,
          traded: false,
          expiryCandles: 48,
        });
      }
    }
  }

  return newLevels;
}

// ─── V5: FVG Detection ──────────────────────────────────────────────────────

export function detectFVGs(
  candles: BacktestCandle[],
  indicators: IndicatorState,
  idx: number,
): FairValueGap[] {
  const fvgs: FairValueGap[] = [];
  if (idx < 2) return fvgs;

  const atr = indicators.atr14[idx];
  if (isNaN(atr) || atr === 0) return fvgs;

  const curr = candles[idx];
  const prev = candles[idx - 1];
  const prev2 = candles[idx - 2];

  const middleBody = Math.abs(prev.close - prev.open);
  const middleRange = prev.high - prev.low;
  if (middleRange === 0) return fvgs;
  if (middleBody / middleRange < 0.4) return fvgs;
  if (middleRange < atr * 0.5) return fvgs;

  if (curr.low > prev2.high) {
    fvgs.push({
      direction: 'BUY',
      zoneHigh: curr.low,
      zoneLow: prev2.high,
      createdAtIndex: idx,
      expiryCandles: 96,
      traded: false,
    });
  }

  if (curr.high < prev2.low) {
    fvgs.push({
      direction: 'SELL',
      zoneHigh: prev2.low,
      zoneLow: curr.high,
      createdAtIndex: idx,
      expiryCandles: 96,
      traded: false,
    });
  }

  return fvgs;
}

// ─── V6: FVG Fill Entry (with quality scoring + regime params) ───────────────

export function evaluateFVGEntry(
  m15Candles: BacktestCandle[],
  m15Indicators: IndicatorState,
  h1Candles: BacktestCandle[],
  h1Indicators: IndicatorState,
  idx: number,
  activeFVGs: FairValueGap[],
  spread: number,
  minAtr: number,
  pricePrecision: number,
  regimeState: RegimeState,
  minQuality: number = 35,
): SetupSignal | null {
  if (idx < 50) return null;

  const candle = m15Candles[idx];
  const atr = m15Indicators.atr14[idx];
  const rsi = m15Indicators.rsi14[idx];

  if (isNaN(atr) || atr === 0 || isNaN(rsi)) return null;
  if (atr < minAtr) return null;

  // Hard reject: extreme volatility
  const atrBaseline = m15Indicators.atrBaseline[idx];
  if (!isNaN(atrBaseline) && atrBaseline > 0 && atr / atrBaseline >= 2.0) return null;

  if (!isActiveTradingSession(candle.openTime)) return null;

  // V6 (round 3): FVG works in all regimes except deep ranging (ADX < 10)
  if (regimeState.adx < 10) return null;

  const halfSpread = spread / 2;
  const factor = Math.pow(10, pricePrecision);
  const regimeParams = getRegimeParams(regimeState.regime);

  for (const fvg of activeFVGs) {
    if (fvg.traded) continue;
    if (idx - fvg.createdAtIndex > fvg.expiryCandles) continue;
    if (idx <= fvg.createdAtIndex) continue;

    // H1 bias must not oppose FVG direction (NEUTRAL OK)
    const { bias } = getH1Regime(h1Candles, h1Indicators, candle.openTime);
    if (fvg.direction === 'BUY' && bias === 'BEARISH') continue;
    if (fvg.direction === 'SELL' && bias === 'BULLISH') continue;

    const isBullish = fvg.direction === 'BUY';

    // RSI filter: 20-80
    if (rsi < 20 || rsi > 80) continue;

    // When H1 bias is NEUTRAL, require M15 EMA alignment
    if (bias === 'NEUTRAL') {
      const ema20 = m15Indicators.ema20[idx];
      const ema50 = m15Indicators.ema50[idx];
      if (!isNaN(ema20) && !isNaN(ema50)) {
        if (isBullish && ema20 < ema50) continue;
        if (!isBullish && ema20 > ema50) continue;
      }
    }

    // Fill: candle enters FVG zone
    if (isBullish) {
      if (candle.low > fvg.zoneHigh || candle.high < fvg.zoneLow) continue;
      if (candle.close <= candle.open) continue;
    } else {
      if (candle.high < fvg.zoneLow || candle.low > fvg.zoneHigh) continue;
      if (candle.close >= candle.open) continue;
    }

    // Entry price
    const entryPrice = isBullish
      ? candle.close + halfSpread
      : candle.close - halfSpread;

    // SL: beyond FVG zone extreme + ATR*0.3
    let slPrice = isBullish
      ? fvg.zoneLow - atr * 0.3
      : fvg.zoneHigh + atr * 0.3;

    // SL clamp: use regime params
    let slDistance = Math.abs(entryPrice - slPrice);
    if (slDistance < atr * 0.6) {
      slPrice = isBullish ? entryPrice - atr * 0.6 : entryPrice + atr * 0.6;
    }
    // V6: Hard reject > 3.0 ATR (was 2.5)
    if (slDistance > atr * 3.0) continue;
    // Clamp to regime max
    const fvgSlMax = atr * regimeParams.slClampMaxAtr;
    if (slDistance > fvgSlMax) {
      slPrice = isBullish ? entryPrice - fvgSlMax : entryPrice + fvgSlMax;
    }

    // Quality scoring for FVG
    let quality = 55; // base for FVG

    // ADX quality (structural, not trend-dependent)
    if (regimeState.adx >= 25) quality += 10;
    else if (regimeState.adx >= 20) quality += 5;
    else if (regimeState.adx >= 15) quality += 0;
    else quality -= 10; // 12-15, marginal

    // SL distance penalty — wider SL = lower quality
    slDistance = Math.abs(entryPrice - slPrice);
    if (slDistance > atr * 2.0) quality -= 10;
    else if (slDistance > atr * 1.5) quality -= 5;

    // Regime alignment
    if (regimeState.regime === 'STRONG_TREND' && bias !== 'NEUTRAL') quality += 10;
    else if (regimeState.regime === 'WEAK_TREND') quality += 0;
    else if (regimeState.regime === 'VOLATILE') quality -= 10;

    // RSI alignment
    if (isBullish && rsi >= 40 && rsi <= 60) quality += 5;
    else if (!isBullish && rsi >= 40 && rsi <= 60) quality += 5;

    if (quality < minQuality) continue;

    // TP: regime-adaptive
    const risk = Math.abs(entryPrice - slPrice);
    const tpPrice = isBullish ? entryPrice + risk * regimeParams.fvgTpR : entryPrice - risk * regimeParams.fvgTpR;

    const tags: string[] = ['FVG_FILL', 'V6.0', regimeState.regime, isBullish ? 'ADX_BULL' : 'ADX_BEAR'];

    return {
      side: isBullish ? 'BUY' : 'SELL',
      entryPrice: Math.round(entryPrice * factor) / factor,
      slPrice: Math.round(slPrice * factor) / factor,
      tpPrice: Math.round(tpPrice * factor) / factor,
      setupTags: tags,
      h1Bias: bias,
      rsiAtEntry: Math.round(rsi * 100) / 100,
      atrAtEntry: Math.round(atr * 100000) / 100000,
      setupType: 'FVG_FILL',
      qualityScore: quality,
      regimeTradeParams: regimeParams,
    };
  }

  return null;
}

// ─── V6: Quality Score Calculator (enhanced) ──────────────────────────────────

/**
 * V6: Calculate quality score for any setup signal.
 * This is used when quality wasn't already computed inline (legacy path).
 */
export function calculateQualityScore(
  m15Candles: BacktestCandle[],
  m15Indicators: IndicatorState,
  h1Candles: BacktestCandle[],
  h1Indicators: IndicatorState,
  idx: number,
  signal: SetupSignal,
): number {
  // If already scored by V6 evaluators, return that
  if (signal.qualityScore !== undefined) return signal.qualityScore;

  let score = 0;

  const candle = m15Candles[idx];
  const atr = m15Indicators.atr14[idx];
  const rsi = m15Indicators.rsi14[idx];
  const ema20 = m15Indicators.ema20[idx];
  const ema50 = m15Indicators.ema50[idx];
  const ema200 = m15Indicators.ema200[idx];

  const { h1Adx, bias } = getH1Regime(h1Candles, h1Indicators, candle.openTime);
  if (h1Adx >= 30) score += 20;
  else if (h1Adx >= 25) score += 10;
  else if (h1Adx >= 20) score += 5;

  if (signal.side === 'BUY' && rsi >= 40 && rsi <= 60) score += 10;
  if (signal.side === 'SELL' && rsi >= 40 && rsi <= 60) score += 10;

  if (
    (signal.side === 'BUY' && bias === 'BULLISH') ||
    (signal.side === 'SELL' && bias === 'BEARISH')
  ) {
    score += 15;
  }

  if (signal.setupTags.includes('ENGULFING')) score += 10;
  else if (signal.setupTags.includes('STRONG_CLOSE') || signal.setupTags.includes('PIN_BAR')) score += 8;

  const stability = getH1RegimeStabilityCount(h1Candles, h1Indicators, candle.openTime);
  if (stability >= 3) score += 10;
  else if (stability >= 2) score += 5;

  if (!isNaN(ema20) && !isNaN(ema50) && !isNaN(ema200)) {
    if (ema20 > ema50 && ema50 > ema200 && signal.side === 'BUY') score += 10;
    if (ema20 < ema50 && ema50 < ema200 && signal.side === 'SELL') score += 10;
  }

  const londonHour = getLocalHour(candle.openTime, 'Europe/London');
  const nyHour = getLocalHour(candle.openTime, 'America/New_York');
  if (londonHour >= 13 && londonHour < 17 && nyHour >= 8 && nyHour < 12) {
    score += 7;
  } else if (londonHour >= 8 && londonHour < 17) {
    score += 5;
  } else if (nyHour >= 8 && nyHour < 14) {
    score += 3;
  }

  const atrBaseline = m15Indicators.atrBaseline[idx];
  if (!isNaN(atrBaseline) && atrBaseline > 0) {
    const ratio = atr / atrBaseline;
    if (ratio >= 0.8 && ratio <= 1.3) score += 10;
  }

  return score;
}
