import { EMA, RSI, ATR, ADX, SMA } from 'technicalindicators';
import { BacktestCandle, IndicatorState } from './types';

/**
 * Pre-compute all indicators over the full candle array.
 * Each array is aligned so index i corresponds to candle i.
 * Indices before the indicator has enough data are filled with NaN.
 */
export function computeIndicators(candles: BacktestCandle[]): IndicatorState {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  const ema20Raw = EMA.calculate({ period: 20, values: closes });
  const ema50Raw = EMA.calculate({ period: 50, values: closes });
  const ema200Raw = EMA.calculate({ period: 200, values: closes });
  const rsi14Raw = RSI.calculate({ period: 14, values: closes });
  const atr14Raw = ATR.calculate({
    period: 14,
    high: highs,
    low: lows,
    close: closes,
  });

  const atrBaselineRaw = SMA.calculate({ period: 20, values: atr14Raw });

  // ADX returns { adx, pdi, mdi } for each period
  const adxRaw = ADX.calculate({
    period: 14,
    high: highs,
    low: lows,
    close: closes,
  });

  // Pad front with NaN to align with candle indices
  const pad = (arr: number[]): number[] => {
    const offset = closes.length - arr.length;
    return [...Array(offset).fill(NaN), ...arr];
  };

  return {
    ema20: pad(ema20Raw),
    ema50: pad(ema50Raw),
    ema200: pad(ema200Raw),
    rsi14: pad(rsi14Raw),
    atr14: pad(atr14Raw),
    adx14: pad(adxRaw.map((v) => v.adx)),
    plusDI14: pad(adxRaw.map((v) => v.pdi)),
    minusDI14: pad(adxRaw.map((v) => v.mdi)),
    atrBaseline: pad(atrBaselineRaw),
  };
}
