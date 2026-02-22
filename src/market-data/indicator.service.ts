import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@app/prisma';
import { CandleService } from './candle.service';
import { SYMBOL, Timeframe, IndicatorName, MarketSnapshotDto } from '@app/common';
import { EMA, RSI, ATR } from 'technicalindicators';

@Injectable()
export class IndicatorService {
  private readonly logger = new Logger(IndicatorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly candleService: CandleService,
  ) {}

  async computeAndStore(timeframe: string): Promise<void> {
    const candles = await this.candleService.getRecentCandles(timeframe, 250);
    if (candles.length < 200) {
      this.logger.warn(
        `Not enough candles for ${timeframe}: ${candles.length}`,
      );
      return;
    }

    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);

    const ema20 = EMA.calculate({ period: 20, values: closes });
    const ema50 = EMA.calculate({ period: 50, values: closes });
    const ema200 = EMA.calculate({ period: 200, values: closes });
    const rsi14 = RSI.calculate({ period: 14, values: closes });
    const atr14 = ATR.calculate({
      period: 14,
      high: highs,
      low: lows,
      close: closes,
    });

    const lastCandle = candles[candles.length - 1];
    const openTime = new Date(lastCandle.openTime);

    const indicators = [
      { name: IndicatorName.EMA20, value: ema20[ema20.length - 1] },
      { name: IndicatorName.EMA50, value: ema50[ema50.length - 1] },
      { name: IndicatorName.EMA200, value: ema200[ema200.length - 1] },
      { name: IndicatorName.RSI14, value: rsi14[rsi14.length - 1] },
      { name: IndicatorName.ATR14, value: atr14[atr14.length - 1] },
    ];

    for (const ind of indicators) {
      if (ind.value === undefined) continue;
      await this.prisma.indicator.upsert({
        where: {
          symbol_timeframe_openTime_name: {
            symbol: SYMBOL,
            timeframe,
            openTime,
            name: ind.name,
          },
        },
        update: { value: ind.value },
        create: {
          symbol: SYMBOL,
          timeframe,
          openTime,
          name: ind.name,
          value: ind.value,
        },
      });
    }
  }

  async getLatestIndicators(
    timeframe: string,
  ): Promise<Record<string, number>> {
    const indicators = await this.prisma.indicator.findMany({
      where: { symbol: SYMBOL, timeframe },
      orderBy: { openTime: 'desc' },
      take: 5,
      distinct: ['name'],
    });

    const result: Record<string, number> = {};
    for (const ind of indicators) {
      result[ind.name] = ind.value;
    }
    return result;
  }

  async getMarketSnapshot(): Promise<MarketSnapshotDto> {
    const candles = await this.candleService.getRecentCandles(Timeframe.M15, 1);
    const lastCandle = candles.length > 0 ? candles[0] : null;

    const indicators = await this.getLatestIndicators(Timeframe.M15);

    return {
      symbol: SYMBOL,
      timeframe: Timeframe.M15,
      currentPrice: lastCandle?.close ?? 0,
      ema20: indicators[IndicatorName.EMA20] ?? 0,
      ema50: indicators[IndicatorName.EMA50] ?? 0,
      ema200: indicators[IndicatorName.EMA200] ?? 0,
      rsi14: indicators[IndicatorName.RSI14] ?? 0,
      atr14: indicators[IndicatorName.ATR14] ?? 0,
      lastCandle,
    };
  }
}
