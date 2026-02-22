import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { HttpService } from '@nestjs/axios';
import { PrismaService } from '@app/prisma';
import { RedisService, REDIS_CHANNELS } from '@app/redis';
import { SYMBOL, SERVICE_URLS } from '@app/common';
import { Timeframe, CandleDto } from '@app/common';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class CandleService implements OnModuleInit {
  private readonly logger = new Logger(CandleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly httpService: HttpService,
  ) {}

  async onModuleInit() {
    this.logger.log('Candle service initialized');
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async pollCandles() {
    try {
      await this.fetchAndStoreCandles(Timeframe.M15, 5);
      await this.fetchAndStoreCandles(Timeframe.H1, 3);
    } catch (error) {
      this.logger.error(`Failed to poll candles: ${error.message}`);
    }
  }

  async fetchAndStoreCandles(
    timeframe: string,
    count: number,
  ): Promise<void> {
    try {
      const response = await firstValueFrom(
        this.httpService.get<CandleDto[]>(
          `${SERVICE_URLS.EXECUTION}/candles`,
          { params: { symbol: SYMBOL, timeframe, count } },
        ),
      );

      const candles = response.data;
      let newCandleStored = false;

      for (const candle of candles) {
        const result = await this.prisma.candle.upsert({
          where: {
            symbol_timeframe_openTime: {
              symbol: candle.symbol,
              timeframe: candle.timeframe,
              openTime: new Date(candle.openTime),
            },
          },
          update: {
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
          },
          create: {
            symbol: candle.symbol,
            timeframe: candle.timeframe,
            openTime: new Date(candle.openTime),
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
          },
        });
        newCandleStored = true;
      }

      if (newCandleStored && timeframe === Timeframe.M15) {
        await this.redis.publish(REDIS_CHANNELS.CANDLE_STORED, {
          symbol: SYMBOL,
          timeframe,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (error) {
      this.logger.error(
        `Failed to fetch candles for ${timeframe}: ${error.message}`,
      );
    }
  }

  async getRecentCandles(
    timeframe: string,
    count: number,
  ): Promise<CandleDto[]> {
    const candles = await this.prisma.candle.findMany({
      where: { symbol: SYMBOL, timeframe },
      orderBy: { openTime: 'desc' },
      take: count,
    });

    return candles
      .reverse()
      .map((c) => ({
        symbol: c.symbol,
        timeframe: c.timeframe,
        openTime: c.openTime.toISOString(),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      }));
  }
}
