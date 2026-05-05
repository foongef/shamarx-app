import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { HttpService } from '@nestjs/axios';
import { PrismaService } from '@app/prisma';
import { RedisService, REDIS_CHANNELS } from '@app/redis';
import { SYMBOL, SERVICE_URLS } from '@app/common';
import { Timeframe, CandleDto } from '@app/common';
import { firstValueFrom } from 'rxjs';

/** Milliseconds per bar — used to filter out the currently-forming bar. */
const TIMEFRAME_MS: Record<string, number> = {
  M1: 60_000,
  M5: 5 * 60_000,
  M15: 15 * 60_000,
  H1: 60 * 60_000,
  H4: 4 * 60 * 60_000,
  D1: 24 * 60 * 60_000,
};

@Injectable()
export class CandleService implements OnModuleInit {
  private readonly logger = new Logger(CandleService.name);
  private readonly pairs: string[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly httpService: HttpService,
    private readonly config: ConfigService,
  ) {
    const pairsCsv = this.config.get<string>('STRATEGY_PAIRS') || SYMBOL;
    this.pairs = pairsCsv
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
  }

  async onModuleInit() {
    this.logger.log(`Candle service initialized for pairs: ${this.pairs.join(', ')}`);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async pollCandles() {
    // Poll all configured pairs in parallel. Each pair × timeframe runs
    // independently so a single failure doesn't stop the others.
    await Promise.all(
      this.pairs.flatMap((symbol) => [
        this.fetchAndStoreCandles(symbol, Timeframe.M15, 5),
        this.fetchAndStoreCandles(symbol, Timeframe.H1, 3),
      ]),
    );
  }

  async fetchAndStoreCandles(
    symbol: string,
    timeframe: string,
    count: number,
  ): Promise<void> {
    try {
      const response = await firstValueFrom(
        this.httpService.get<CandleDto[]>(
          `${SERVICE_URLS.EXECUTION}/candles`,
          { params: { symbol, timeframe, count } },
        ),
      );

      const candles = response.data;

      // Drop the in-progress (open) bar. Broker returns the currently-forming
      // bar as the last element; storing it would mutate-on-each-poll, breaking
      // the "Candle = immutable historical event" invariant.
      const tfMs = TIMEFRAME_MS[timeframe] ?? 0;
      const closedCandles = tfMs > 0
        ? candles.filter(
            (c) => Date.now() >= new Date(c.openTime).getTime() + tfMs,
          )
        : candles;

      // Append-only: skipDuplicates ensures we never overwrite a row, so
      // closed candles stay immutable even if the broker re-emits them.
      let newCandleStored = false;
      if (closedCandles.length > 0) {
        const result = await this.prisma.candle.createMany({
          data: closedCandles.map((c) => ({
            symbol: c.symbol,
            timeframe: c.timeframe,
            openTime: new Date(c.openTime),
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
          })),
          skipDuplicates: true,
        });
        newCandleStored = result.count > 0;
      }

      if (newCandleStored && timeframe === Timeframe.M15) {
        await this.redis.publish(REDIS_CHANNELS.CANDLE_STORED, {
          symbol,
          timeframe,
          timestamp: new Date().toISOString(),
        });
      }
      // Heartbeat — write cron's last successful poll time. The loop-health
      // pill reads this to confirm the cron is alive even when no NEW candle
      // arrived (M15 bar still in progress). 5min TTL so a dead cron quickly
      // reflects in health.
      await this.redis.set(
        `live:cron:last-poll:${symbol}:${timeframe}`,
        new Date().toISOString(),
        300,
      );
    } catch (error) {
      this.logger.error(
        `Failed to fetch candles for ${symbol} ${timeframe}: ${(error as Error).message}`,
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
