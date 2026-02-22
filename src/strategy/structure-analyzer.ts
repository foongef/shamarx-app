import { Injectable, Logger } from '@nestjs/common';
import { CandleDto, Side } from '@app/common';

export interface SwingPoint {
  index: number;
  price: number;
  type: 'HIGH' | 'LOW';
}

export interface BOSEvent {
  direction: Side;
  brokenLevel: number;
  candleIndex: number;
}

@Injectable()
export class StructureAnalyzer {
  private readonly logger = new Logger(StructureAnalyzer.name);

  detectSwingPoints(candles: CandleDto[], lookback: number = 2): SwingPoint[] {
    const points: SwingPoint[] = [];

    for (let i = lookback; i < candles.length - lookback; i++) {
      const curr = candles[i];

      // Check swing high
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

      // Check swing low
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

  detectBOS(candles: CandleDto[], swingPoints: SwingPoint[]): BOSEvent | null {
    if (swingPoints.length < 3) return null;

    // Look at the most recent swing points
    const recentPoints = swingPoints.slice(-6);
    const lastCandle = candles[candles.length - 1];

    // Find the most recent swing high and swing low
    const swingHighs = recentPoints.filter((p) => p.type === 'HIGH');
    const swingLows = recentPoints.filter((p) => p.type === 'LOW');

    if (swingHighs.length === 0 || swingLows.length === 0) return null;

    const lastSwingHigh = swingHighs[swingHighs.length - 1];
    const lastSwingLow = swingLows[swingLows.length - 1];

    // Bullish BOS: price breaks above the last swing high
    if (lastCandle.close > lastSwingHigh.price) {
      return {
        direction: Side.BUY,
        brokenLevel: lastSwingHigh.price,
        candleIndex: candles.length - 1,
      };
    }

    // Bearish BOS: price breaks below the last swing low
    if (lastCandle.close < lastSwingLow.price) {
      return {
        direction: Side.SELL,
        brokenLevel: lastSwingLow.price,
        candleIndex: candles.length - 1,
      };
    }

    return null;
  }
}
