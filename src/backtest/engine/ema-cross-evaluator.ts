/**
 * V6: EMA20 / EMA50 cross + retest engine.
 *
 * Fires on a classic trend-follow pattern: EMA20 crosses EMA50 in the last
 * N bars, then price pulls back to retest EMA20 (or EMA50 if shallow), then
 * resumes. Triggers far more often than the strict pullback engine because
 * we don't require ADX confirmation, RSI midband, or swing-based SL.
 *
 * Design tradeoff: lower per-trade edge but ~3-5x trade frequency.
 */
import { BacktestCandle, IndicatorState, RegimeState } from './types';
import { isActiveTradingSession, getH1Bias } from './strategy-evaluator';

interface EMACrossSignal {
  side: 'BUY' | 'SELL';
  entryPrice: number;
  slPrice: number;
  tpPrice: number;
  setupTags: string[];
  h1Bias: string;
  rsiAtEntry: number;
  atrAtEntry: number;
  qualityScore?: number;
}

const CROSS_LOOKBACK = 20;       // cross must have happened within last 20 M15 bars (5h)
const RETEST_TOLERANCE_ATR = 0.5; // price must touch EMA20 within this ATR fraction
const TP_R_MULTIPLE = 1.5;       // 1.5R fixed TP
const SL_BUFFER_ATR = 0.4;       // SL beyond opposite EMA + buffer
const MIN_CROSS_SEPARATION = 1.0; // require min EMA spread (in ATR units) post-cross

function detectRecentCross(
  ema20: number[],
  ema50: number[],
  i: number,
): { direction: 'BUY' | 'SELL'; crossIdx: number } | null {
  for (let k = i - 1; k >= Math.max(1, i - CROSS_LOOKBACK); k--) {
    const above = ema20[k] > ema50[k];
    const wasAbove = ema20[k - 1] > ema50[k - 1];
    if (above !== wasAbove && !isNaN(ema20[k]) && !isNaN(ema50[k])) {
      return { direction: above ? 'BUY' : 'SELL', crossIdx: k };
    }
  }
  return null;
}

export function evaluateEmaCross(
  m15Candles: BacktestCandle[],
  m15Indicators: IndicatorState,
  h1Candles: BacktestCandle[],
  h1Indicators: IndicatorState,
  i: number,
  spread: number,
  minAtr: number,
  pricePrecision: number,
  regimeState: RegimeState | null,
  _minQuality: number,
): EMACrossSignal | null {
  if (i < CROSS_LOOKBACK + 2) return null;
  const candle = m15Candles[i];

  // Skip clearly hostile regimes
  if (!regimeState) return null;
  if (regimeState.regime === 'VOLATILE') return null;

  if (!isActiveTradingSession(candle.openTime)) return null;

  const atr = m15Indicators.atr14[i];
  if (isNaN(atr) || atr < minAtr) return null;

  const ema20 = m15Indicators.ema20[i];
  const ema50 = m15Indicators.ema50[i];
  if (isNaN(ema20) || isNaN(ema50)) return null;

  const cross = detectRecentCross(m15Indicators.ema20, m15Indicators.ema50, i);
  if (!cross) return null;

  // Require some EMA separation since the cross — too-tight EMAs are choppy
  const sep = Math.abs(ema20 - ema50);
  if (sep < atr * MIN_CROSS_SEPARATION) return null;

  // Direction must agree with the cross direction
  // Retest: bar low touched EMA20 within tolerance for BUY (or high for SELL)
  const tolerance = atr * RETEST_TOLERANCE_ATR;
  const halfSpread = spread / 2;
  const factor = Math.pow(10, pricePrecision);
  const h1Bias = getH1Bias(h1Candles, h1Indicators, candle.openTime);

  if (cross.direction === 'BUY') {
    // EMA20 above EMA50, looking for pullback-and-bounce
    const touchedEma = candle.low <= ema20 + tolerance && candle.low >= ema20 - tolerance * 2;
    const closedAbove = candle.close > ema20 && candle.close > candle.open;
    if (!touchedEma || !closedAbove) return null;

    const entryPrice = candle.close + halfSpread;
    const slPrice = Math.min(candle.low, ema50) - atr * SL_BUFFER_ATR;
    const slPoints = Math.abs(entryPrice - slPrice);
    if (slPoints <= 0) return null;
    const tpPrice = entryPrice + slPoints * TP_R_MULTIPLE;

    const tags = ['EMA_CROSS', 'BUY_RETEST'];
    if (h1Bias === 'BULLISH') tags.push('H1_AGREE');
    return {
      side: 'BUY',
      entryPrice: Math.round(entryPrice * factor) / factor,
      slPrice: Math.round(slPrice * factor) / factor,
      tpPrice: Math.round(tpPrice * factor) / factor,
      setupTags: tags,
      h1Bias,
      rsiAtEntry: m15Indicators.rsi14[i] ?? 50,
      atrAtEntry: atr,
    };
  }

  // SELL: EMA20 below EMA50, looking for retracement-and-rejection
  const touchedEma = candle.high >= ema20 - tolerance && candle.high <= ema20 + tolerance * 2;
  const closedBelow = candle.close < ema20 && candle.close < candle.open;
  if (!touchedEma || !closedBelow) return null;

  const entryPrice = candle.close - halfSpread;
  const slPrice = Math.max(candle.high, ema50) + atr * SL_BUFFER_ATR;
  const slPoints = Math.abs(slPrice - entryPrice);
  if (slPoints <= 0) return null;
  const tpPrice = entryPrice - slPoints * TP_R_MULTIPLE;

  const tags = ['EMA_CROSS', 'SELL_RETEST'];
  if (h1Bias === 'BEARISH') tags.push('H1_AGREE');
  return {
    side: 'SELL',
    entryPrice: Math.round(entryPrice * factor) / factor,
    slPrice: Math.round(slPrice * factor) / factor,
    tpPrice: Math.round(tpPrice * factor) / factor,
    setupTags: tags,
    h1Bias,
    rsiAtEntry: m15Indicators.rsi14[i] ?? 50,
    atrAtEntry: atr,
  };
}
