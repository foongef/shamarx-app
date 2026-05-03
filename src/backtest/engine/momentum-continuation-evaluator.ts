/**
 * V6: Momentum continuation engine — high-frequency trend-follow.
 *
 * Fires when:
 *   1. 3 of last 4 M15 bars closed in the same direction
 *   2. Latest bar closed >50% of its range AND beyond EMA20
 *   3. H1 EMA20/EMA50 stack agrees with direction (light HTF filter)
 *   4. Active trading session, ATR healthy
 *
 * Lower per-trade edge (~1.2R fixed TP) but very high signal frequency —
 * adds ~1-2 trades per week on top of the main engines. The intent is to
 * push trade count toward the 10-15/mo target without sacrificing the
 * higher-edge engines' trades.
 */
import { BacktestCandle, IndicatorState, RegimeState } from './types';
import { isActiveTradingSession, getH1Bias } from './strategy-evaluator';

interface MomentumSignal {
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

const TP_R = 1.2;
const SL_BUFFER_ATR = 0.5;
const MIN_BODY_RATIO = 0.55;

/** True iff the last 4 bars have ≥3 closes in `direction`. */
function consecutiveDirection(
  candles: BacktestCandle[],
  i: number,
  direction: 'BUY' | 'SELL',
): boolean {
  if (i < 4) return false;
  let count = 0;
  for (let k = i; k > i - 4; k--) {
    const c = candles[k];
    if (direction === 'BUY' && c.close > c.open) count++;
    else if (direction === 'SELL' && c.close < c.open) count++;
  }
  return count >= 3;
}

export function evaluateMomentumContinuation(
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
): MomentumSignal | null {
  if (i < 4) return null;
  const candle = m15Candles[i];

  if (!regimeState) return null;
  if (regimeState.regime === 'VOLATILE') return null;
  if (!isActiveTradingSession(candle.openTime)) return null;

  const atr = m15Indicators.atr14[i];
  if (isNaN(atr) || atr < minAtr) return null;

  const ema20 = m15Indicators.ema20[i];
  if (isNaN(ema20)) return null;

  // Need a strong-bodied bar in the trend direction
  const range = candle.high - candle.low;
  if (range === 0) return null;
  const body = Math.abs(candle.close - candle.open);
  if (body / range < MIN_BODY_RATIO) return null;

  const h1Bias = getH1Bias(h1Candles, h1Indicators, candle.openTime);
  const halfSpread = spread / 2;
  const factor = Math.pow(10, pricePrecision);

  const isBull = candle.close > candle.open;

  // BUY: bullish momentum + close above EMA20 + H1 bias not opposing + 3/4 bullish bars
  if (isBull && candle.close > ema20 && h1Bias !== 'BEARISH' && consecutiveDirection(m15Candles, i, 'BUY')) {
    const entryPrice = candle.close + halfSpread;
    const slPrice = Math.min(candle.low, ema20 - atr * SL_BUFFER_ATR);
    const slPoints = Math.abs(entryPrice - slPrice);
    if (slPoints <= 0 || slPoints > atr * 3) return null;
    const tpPrice = entryPrice + slPoints * TP_R;

    const tags = ['MOMENTUM_CONT', 'BUY_MOM'];
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

  // SELL: mirror
  if (!isBull && candle.close < ema20 && h1Bias !== 'BULLISH' && consecutiveDirection(m15Candles, i, 'SELL')) {
    const entryPrice = candle.close - halfSpread;
    const slPrice = Math.max(candle.high, ema20 + atr * SL_BUFFER_ATR);
    const slPoints = Math.abs(slPrice - entryPrice);
    if (slPoints <= 0 || slPoints > atr * 3) return null;
    const tpPrice = entryPrice - slPoints * TP_R;

    const tags = ['MOMENTUM_CONT', 'SELL_MOM'];
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

  return null;
}
