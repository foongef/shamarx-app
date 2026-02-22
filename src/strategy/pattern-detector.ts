import { Injectable, Logger } from '@nestjs/common';
import { CandleDto, SetupTag } from '@app/common';

@Injectable()
export class PatternDetector {
  private readonly logger = new Logger(PatternDetector.name);

  detectEngulfing(candles: CandleDto[]): boolean {
    if (candles.length < 2) return false;

    const prev = candles[candles.length - 2];
    const curr = candles[candles.length - 1];

    // Bullish engulfing
    const isBullishEngulfing =
      prev.close < prev.open && // prev is bearish
      curr.close > curr.open && // curr is bullish
      curr.open <= prev.close && // curr opens at or below prev close
      curr.close >= prev.open; // curr closes at or above prev open

    // Bearish engulfing
    const isBearishEngulfing =
      prev.close > prev.open && // prev is bullish
      curr.close < curr.open && // curr is bearish
      curr.open >= prev.close && // curr opens at or above prev close
      curr.close <= prev.open; // curr closes at or below prev open

    return isBullishEngulfing || isBearishEngulfing;
  }

  detectStrongClose(candles: CandleDto[]): boolean {
    if (candles.length < 1) return false;

    const curr = candles[candles.length - 1];
    const range = curr.high - curr.low;
    if (range === 0) return false;

    const isBullish = curr.close > curr.open;
    const body = Math.abs(curr.close - curr.open);
    const bodyRatio = body / range;

    // Strong close: body is at least 60% of the range
    if (bodyRatio < 0.6) return false;

    if (isBullish) {
      // Close in upper 25% of range
      return (curr.close - curr.low) / range >= 0.75;
    } else {
      // Close in lower 25% of range
      return (curr.high - curr.close) / range >= 0.75;
    }
  }

  isPullbackToEMA(
    candle: CandleDto,
    emaValue: number,
    atr: number,
  ): boolean {
    if (!emaValue || !atr) return false;

    // Price touched or came within 0.5 ATR of the EMA
    const tolerance = atr * 0.5;
    const low = candle.low;
    const high = candle.high;

    return (
      (low <= emaValue + tolerance && high >= emaValue - tolerance)
    );
  }

  isRSIAligned(rsi: number, isBullish: boolean): boolean {
    if (isBullish) {
      return rsi > 50 && rsi < 70; // Bullish but not overbought
    } else {
      return rsi < 50 && rsi > 30; // Bearish but not oversold
    }
  }

  getConfirmationTags(
    candles: CandleDto[],
    ema20: number,
    ema50: number,
    rsi: number,
    atr: number,
    isBullish: boolean,
  ): string[] {
    const tags: string[] = [];
    const lastCandle = candles[candles.length - 1];

    if (this.detectEngulfing(candles)) {
      tags.push(SetupTag.ENGULFING);
    }

    if (this.detectStrongClose(candles)) {
      tags.push(SetupTag.STRONG_CLOSE);
    }

    if (this.isPullbackToEMA(lastCandle, ema20, atr)) {
      tags.push(SetupTag.PULLBACK_EMA20);
    }

    if (this.isPullbackToEMA(lastCandle, ema50, atr)) {
      tags.push(SetupTag.PULLBACK_EMA50);
    }

    if (this.isRSIAligned(rsi, isBullish)) {
      tags.push(SetupTag.RSI_ALIGNED);
    }

    return tags;
  }
}
