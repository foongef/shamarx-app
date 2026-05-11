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
    // Poll M15+H1 from broker. We deliberately do NOT poll D1 from the
    // broker — broker D1 bars are session-aligned (closes at 21:00 UTC
    // winter / 22:00 UTC summer), but our 11 years of locked-in backtest
    // history uses Dukascopy's UTC-midnight alignment. Mixing alignments
    // pollutes the D1 ADX/EMA50 indicator series the strategy relies on.
    await Promise.all(
      this.pairs.flatMap((symbol) => [
        this.fetchAndStoreCandles(symbol, Timeframe.M15, 5),
        this.fetchAndStoreCandles(symbol, Timeframe.H1, 3),
      ]),
    );

    // After H1 is fresh, resample yesterday's 24 H1 bars into a single
    // UTC-midnight-aligned D1 bar. Idempotent (skipDuplicates), runs every
    // minute but only writes once per pair-day (when the new D1 first
    // becomes available). Keeps the live D1 series consistent with the
    // Dukascopy-backfilled historical bars.
    for (const symbol of this.pairs) {
      try {
        await this.resampleH1ToD1(symbol);
      } catch (err) {
        this.logger.warn(
          `D1 resample ${symbol} failed: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * Build today's most recent CLOSED UTC day's D1 bar from its 24 H1 bars.
   * UTC-midnight aligned, same alignment Dukascopy backfill uses. Skipped
   * silently if any of the 24 H1 bars is missing (transient cron lag).
   */
  private async resampleH1ToD1(symbol: string): Promise<void> {
    // Most recent fully-closed UTC day = yesterday relative to now.
    const now = new Date();
    const dayStart = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 0, 0, 0, 0,
    ));
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60_000);

    const h1 = await this.prisma.candle.findMany({
      where: {
        symbol,
        timeframe: Timeframe.H1,
        openTime: { gte: dayStart, lt: dayEnd },
      },
      orderBy: { openTime: 'asc' },
    });
    if (h1.length === 0) return; // weekend or pre-data-history; skip silently
    // Weekends naturally have fewer H1 bars — we still resample what we have
    // (Sunday after 21:00 UTC has ~3 bars). Match Dukascopy's pandas resample,
    // which also keeps weekend-edge daily bars.

    const open = h1[0].open;
    const close = h1[h1.length - 1].close;
    const high = Math.max(...h1.map((b) => b.high));
    const low = Math.min(...h1.map((b) => b.low));
    const volume = h1.reduce((s, b) => s + b.volume, 0);

    await this.prisma.candle.createMany({
      data: [{
        symbol,
        timeframe: Timeframe.D1,
        openTime: dayStart,
        open,
        high,
        low,
        close,
        volume,
      }],
      skipDuplicates: true, // once-per-day write — first cron tick after midnight wins
    });
    // Heartbeat — same shape as the M15/H1 path so health-monitor stays uniform.
    await this.redis.set(
      `live:cron:last-poll:${symbol}:${Timeframe.D1}`,
      new Date().toISOString(),
      300,
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
