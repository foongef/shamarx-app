import { EMA, RSI, ATR } from 'technicalindicators';
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

  // Pad front with NaN to align with candle indices
  const pad = (arr: number[], period: number): number[] => {
    const offset = closes.length - arr.length;
    return [...Array(offset).fill(NaN), ...arr];
  };

  return {
    ema20: pad(ema20Raw, 20),
    ema50: pad(ema50Raw, 50),
    ema200: pad(ema200Raw, 200),
    rsi14: pad(rsi14Raw, 14),
    atr14: pad(atr14Raw, 14),
  };
}
