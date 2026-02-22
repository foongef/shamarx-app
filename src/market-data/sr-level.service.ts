import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@app/prisma';
import { CandleService } from './candle.service';
import {
  SYMBOL,
  Timeframe,
  Bias,
  SRType,
  IndicatorName,
  SRLevelDto,
  StructureContextDto,
} from '@app/common';
import { IndicatorService } from './indicator.service';

@Injectable()
export class SRLevelService {
  private readonly logger = new Logger(SRLevelService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly candleService: CandleService,
    private readonly indicatorService: IndicatorService,
  ) {}

  async detectAndStoreLevels(): Promise<void> {
    const candles = await this.candleService.getRecentCandles(Timeframe.H1, 100);
    if (candles.length < 20) return;

    // Mark all existing levels as inactive first
    await this.prisma.supportResistanceLevel.updateMany({
      where: { symbol: SYMBOL, timeframe: Timeframe.H1 },
      data: { isActive: false },
    });

    const swingHighs: number[] = [];
    const swingLows: number[] = [];

    // Detect swing highs and lows (3-bar pattern)
    for (let i = 1; i < candles.length - 1; i++) {
      const prev = candles[i - 1];
      const curr = candles[i];
      const next = candles[i + 1];

      if (curr.high > prev.high && curr.high > next.high) {
        swingHighs.push(curr.high);
      }
      if (curr.low < prev.low && curr.low < next.low) {
        swingLows.push(curr.low);
      }
    }

    // Cluster nearby levels (within 2 points)
    const resistanceLevels = this.clusterLevels(swingHighs, 2.0);
    const supportLevels = this.clusterLevels(swingLows, 2.0);

    for (const level of resistanceLevels) {
      await this.prisma.supportResistanceLevel.create({
        data: {
          symbol: SYMBOL,
          timeframe: Timeframe.H1,
          price: level.price,
          type: SRType.RESISTANCE,
          strength: level.strength,
          isActive: true,
        },
      });
    }

    for (const level of supportLevels) {
      await this.prisma.supportResistanceLevel.create({
        data: {
          symbol: SYMBOL,
          timeframe: Timeframe.H1,
          price: level.price,
          type: SRType.SUPPORT,
          strength: level.strength,
          isActive: true,
        },
      });
    }
  }

  private clusterLevels(
    prices: number[],
    threshold: number,
  ): { price: number; strength: number }[] {
    if (prices.length === 0) return [];

    const sorted = [...prices].sort((a, b) => a - b);
    const clusters: { prices: number[]; sum: number }[] = [];

    let currentCluster = { prices: [sorted[0]], sum: sorted[0] };

    for (let i = 1; i < sorted.length; i++) {
      const avg = currentCluster.sum / currentCluster.prices.length;
      if (sorted[i] - avg <= threshold) {
        currentCluster.prices.push(sorted[i]);
        currentCluster.sum += sorted[i];
      } else {
        clusters.push(currentCluster);
        currentCluster = { prices: [sorted[i]], sum: sorted[i] };
      }
    }
    clusters.push(currentCluster);

    return clusters.map((c) => ({
      price: Math.round((c.sum / c.prices.length) * 100) / 100,
      strength: c.prices.length,
    }));
  }

  async getActiveLevels(): Promise<SRLevelDto[]> {
    const levels = await this.prisma.supportResistanceLevel.findMany({
      where: { symbol: SYMBOL, isActive: true },
      orderBy: { price: 'asc' },
    });

    return levels.map((l) => ({
      price: l.price,
      type: l.type,
      strength: l.strength,
      timeframe: l.timeframe,
    }));
  }

  async getStructureContext(): Promise<StructureContextDto> {
    const h1Indicators = await this.indicatorService.getLatestIndicators(
      Timeframe.H1,
    );

    const ema50 = h1Indicators[IndicatorName.EMA50] ?? 0;
    const ema200 = h1Indicators[IndicatorName.EMA200] ?? 0;

    let h1Bias: Bias;
    if (ema50 > ema200) {
      h1Bias = Bias.BULLISH;
    } else if (ema50 < ema200) {
      h1Bias = Bias.BEARISH;
    } else {
      h1Bias = Bias.NEUTRAL;
    }

    const levels = await this.getActiveLevels();
    const recentSwingHighs = levels
      .filter((l) => l.type === SRType.RESISTANCE)
      .slice(-5)
      .map((l) => l.price);
    const recentSwingLows = levels
      .filter((l) => l.type === SRType.SUPPORT)
      .slice(-5)
      .map((l) => l.price);

    return {
      symbol: SYMBOL,
      h1Bias,
      recentSwingHighs,
      recentSwingLows,
      lastBosDirection: null, // Will be computed by strategy service
    };
  }
}
