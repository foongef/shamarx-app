/**
 * V6 BB Reversal Engine — replacement for the legacy RANGE_ENGINE.
 *
 * Trades mean-reversion bounces off Bollinger Band extremes when the regime
 * is non-trending (ADX < 20) and we'd otherwise have no signal. Validates
 * each entry with a minimum RSI extreme + a reversal candle confirmation,
 * and clamps SL with the same instrument-config guards.
 *
 * Returns the same signal shape as evaluateRangeSetup so the engine routes it
 * identically (quality scoring, lot sizing, BE/trail logic).
 */
import { BollingerBands } from 'technicalindicators';
import {
  BacktestCandle,
  IndicatorState,
  RegimeState,
} from './types';
import { isActiveTradingSession, getH1Bias } from './strategy-evaluator';

interface BBSignal {
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

const BB_PERIOD = 20;
const BB_STDDEV = 2.0;
const RSI_LONG_EXTREME = 32;   // RSI must be ≤32 for BUY (loosened from 28)
const RSI_SHORT_EXTREME = 68;  // RSI must be ≥68 for SELL (loosened from 72)
const SL_BUFFER_ATR = 0.30;    // SL beyond band by this ATR fraction
const TP_R_MULTIPLE = 1.0;     // mean-reversion: 1R target
const MIN_BAND_WIDTH_RATIO = 0.6; // band width / ATR_baseline; skip if too compressed

let _bbCache: { upper: number[]; lower: number[]; middle: number[] } | null = null;
let _bbCacheKey: string | null = null;

function computeBB(candles: BacktestCandle[]): { upper: number[]; lower: number[]; middle: number[] } {
  const key = `${candles.length}-${candles[0]?.openTime ?? ''}-${candles[candles.length - 1]?.openTime ?? ''}`;
  if (_bbCache && _bbCacheKey === key) return _bbCache;
  const closes = candles.map((c) => c.close);
  const raw = BollingerBands.calculate({ period: BB_PERIOD, stdDev: BB_STDDEV, values: closes });
  const offset = closes.length - raw.length;
  const upper = [...Array(offset).fill(NaN), ...raw.map((r) => r.upper)];
  const lower = [...Array(offset).fill(NaN), ...raw.map((r) => r.lower)];
  const middle = [...Array(offset).fill(NaN), ...raw.map((r) => r.middle)];
  _bbCache = { upper, lower, middle };
  _bbCacheKey = key;
  return _bbCache;
}

/** Bullish reversal candle: prior bar made a lower low; current bar closes back above prior close. */
function bullishReversal(candles: BacktestCandle[], i: number): boolean {
  if (i < 1) return false;
  const c = candles[i];
  const p = candles[i - 1];
  return c.low < p.low && c.close > p.close && c.close > c.open;
}

function bearishReversal(candles: BacktestCandle[], i: number): boolean {
  if (i < 1) return false;
  const c = candles[i];
  const p = candles[i - 1];
  return c.high > p.high && c.close < p.close && c.close < c.open;
}

export function evaluateBBReversal(
  m15Candles: BacktestCandle[],
  m15Indicators: IndicatorState,
  h1Candles: BacktestCandle[],
  h1Indicators: IndicatorState,
  i: number,
  spread: number,
  minAtr: number,
  pricePrecision: number,
  regimeState: RegimeState | null,
  minQuality: number,
): BBSignal | null {
  if (i < BB_PERIOD + 1) return null;
  const candle = m15Candles[i];

  // Only run when we're not in a strong trend — BB reversal is a range tool.
  if (!regimeState) return null;
  if (regimeState.regime === 'STRONG_TREND' || regimeState.regime === 'WEAK_TREND') return null;
  if (regimeState.regime === 'VOLATILE') return null; // unreliable in vol spikes

  if (!isActiveTradingSession(candle.openTime)) return null;

  const atr = m15Indicators.atr14[i];
  const atrBaseline = m15Indicators.atrBaseline[i];
  const rsi = m15Indicators.rsi14[i];
  if (isNaN(atr) || atr < minAtr) return null;
  if (isNaN(rsi)) return null;

  const bb = computeBB(m15Candles);
  const upper = bb.upper[i];
  const lower = bb.lower[i];
  const middle = bb.middle[i];
  if (isNaN(upper) || isNaN(lower) || isNaN(middle)) return null;

  // Skip very compressed bands (low expected reversion magnitude).
  const bandWidth = upper - lower;
  if (!isNaN(atrBaseline) && atrBaseline > 0 && bandWidth / atrBaseline < MIN_BAND_WIDTH_RATIO) return null;

  const factor = Math.pow(10, pricePrecision);
  const halfSpread = spread / 2;
  const h1Bias = getH1Bias(h1Candles, h1Indicators, candle.openTime);

  // Long setup: price tagged or pierced lower band, RSI deep oversold, bullish reversal.
  if (candle.low <= lower && rsi <= RSI_LONG_EXTREME && bullishReversal(m15Candles, i)) {
    const entryPrice = candle.close + halfSpread;
    const slPrice = Math.min(candle.low, lower) - atr * SL_BUFFER_ATR;
    const slPoints = Math.abs(entryPrice - slPrice);
    if (slPoints <= 0) return null;
    // TP: middle band OR 1R, whichever is closer (mean-reversion)
    const tpAtMid = middle;
    const tpAtR = entryPrice + slPoints * TP_R_MULTIPLE;
    const tpPrice = Math.min(tpAtMid, tpAtR);
    const tags = ['BB_REVERSAL', 'LONG_BB', `RSI${Math.round(rsi)}`];
    if (h1Bias === 'BULLISH') tags.push('H1_AGREE');
    return {
      side: 'BUY',
      entryPrice: Math.round(entryPrice * factor) / factor,
      slPrice: Math.round(slPrice * factor) / factor,
      tpPrice: Math.round(tpPrice * factor) / factor,
      setupTags: tags,
      h1Bias,
      rsiAtEntry: rsi,
      atrAtEntry: atr,
    };
  }

  // Short setup: mirror.
  if (candle.high >= upper && rsi >= RSI_SHORT_EXTREME && bearishReversal(m15Candles, i)) {
    const entryPrice = candle.close - halfSpread;
    const slPrice = Math.max(candle.high, upper) + atr * SL_BUFFER_ATR;
    const slPoints = Math.abs(slPrice - entryPrice);
    if (slPoints <= 0) return null;
    const tpAtMid = middle;
    const tpAtR = entryPrice - slPoints * TP_R_MULTIPLE;
    const tpPrice = Math.max(tpAtMid, tpAtR);
    const tags = ['BB_REVERSAL', 'SHORT_BB', `RSI${Math.round(rsi)}`];
    if (h1Bias === 'BEARISH') tags.push('H1_AGREE');
    return {
      side: 'SELL',
      entryPrice: Math.round(entryPrice * factor) / factor,
      slPrice: Math.round(slPrice * factor) / factor,
      tpPrice: Math.round(tpPrice * factor) / factor,
      setupTags: tags,
      h1Bias,
      rsiAtEntry: rsi,
      atrAtEntry: atr,
    };
  }

  return null;
}
