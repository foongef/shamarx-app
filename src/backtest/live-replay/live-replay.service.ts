import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@app/prisma';
import { LiveSmcOrchestrator } from '../../strategy/live/live-smc-orchestrator';
import { ReplayEngine, CandleBundle } from './replay-engine';
import { StartReplayDto, REPLAY_DEFAULT_PAIRS } from './dto/start-replay.dto';
import { BacktestCandle } from '../engine/types';

const HTF_WARMUP_DAYS = 90;

@Injectable()
export class LiveReplayService {
  private readonly logger = new Logger(LiveReplayService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orchestrator: LiveSmcOrchestrator,
  ) {}

  async createAndRun(dto: StartReplayDto): Promise<{ id: string; status: string }> {
    const pairs = dto.pairs && dto.pairs.length > 0 ? dto.pairs : REPLAY_DEFAULT_PAIRS;

    const session = await this.prisma.liveReplaySession.create({
      data: {
        startDate: new Date(dto.startDate),
        endDate: new Date(dto.endDate),
        initialBalance: dto.initialBalance,
        riskPercent: dto.riskPercent,
        pairs,
        startEquity: dto.initialBalance,
        status: 'RUNNING',
      },
    });

    // Fire-and-forget — caller polls GET /api/live-replay/:id for status.
    this.execute(session.id, dto, pairs).catch((err) => {
      this.logger.error(`Replay ${session.id} failed: ${err.message}`, err.stack);
    });

    return { id: session.id, status: 'RUNNING' };
  }

  private async execute(sessionId: string, dto: StartReplayDto, pairs: string[]): Promise<void> {
    try {
      const candles = await this.loadCandles(pairs, dto.startDate, dto.endDate);

      // Sanity: refuse to run if any pair lacks the M15 window in the requested range.
      for (const sym of pairs) {
        const m15 = candles[sym]?.m15 ?? [];
        if (m15.length < 200) {
          throw new Error(
            `Insufficient M15 candles for ${sym}: have ${m15.length}, need >= 200. ` +
            `Run \`pnpm data:import ${sym.toLowerCase()} --from <date>\` to backfill.`,
          );
        }
      }

      const engine = new ReplayEngine(this.orchestrator);
      const result = engine.run(
        {
          startDate: dto.startDate,
          endDate: dto.endDate,
          initialBalance: dto.initialBalance,
          riskPercent: dto.riskPercent,
          pairs,
        },
        candles,
      );

      // Persist trades. We write CLOSED rows (entries that closed during the
      // run) — the broker emits a closed-position event that already has both
      // openedAt/closedAt + pnl + exitReason. Open-but-never-closed positions
      // are forced-closed at end-of-run inside the engine, so they show up in
      // the closed list with exitReason=FORCED_CLOSE.
      if (result.closed.length > 0) {
        await this.prisma.liveReplayTrade.createMany({
          data: result.closed.map((t) => ({
            sessionId,
            symbol: t.symbol,
            side: t.side,
            lotSize: t.lotSize,
            entryPrice: t.entryPrice,
            closePrice: t.closePrice,
            slPrice: t.slPrice,
            tpPrice: t.tpPrice,
            status: 'CLOSED',
            exitReason: t.exitReason,
            pnl: t.pnl,
            openedAt: new Date(t.openedAt),
            closedAt: new Date(t.closedAt),
            mode: t.mode,
            setupTags: t.setupTags,
            reason: t.reason,
          })),
        });
      }

      await this.prisma.liveReplaySession.update({
        where: { id: sessionId },
        data: {
          status: 'COMPLETED',
          endedAt: new Date(),
          endEquity: result.finalBalance,
          realizedPnl: result.metrics.realizedPnl,
          tradesCount: result.metrics.tradesCount,
          winsCount: result.metrics.winsCount,
          lossesCount: result.metrics.lossesCount,
          maxOpenConcurrent: result.maxConcurrent,
          metrics: result.metrics as any,
        },
      });

      this.logger.log(
        `Replay ${sessionId} done: ${result.metrics.tradesCount} trades, PnL ${result.metrics.realizedPnl}, return ${result.metrics.netReturnPct}%`,
      );
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`Replay ${sessionId} failed: ${message}`);
      await this.prisma.liveReplaySession.update({
        where: { id: sessionId },
        data: {
          status: 'FAILED',
          endedAt: new Date(),
          errorMessage: message,
        },
      });
    }
  }

  /**
   * Load M15/H1/D1 candles for all pairs. M15 is loaded for the requested
   * range only; H1/D1 also pre-roll {HTF_WARMUP_DAYS} days so D1-ADX/EMA50
   * are warm at the start of the replay window.
   */
  private async loadCandles(
    pairs: string[],
    startDate: string,
    endDate: string,
  ): Promise<CandleBundle> {
    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setUTCHours(23, 59, 59, 999);

    const htfStart = new Date(start);
    htfStart.setUTCDate(htfStart.getUTCDate() - HTF_WARMUP_DAYS);

    const bundle: CandleBundle = {};

    for (const symbol of pairs) {
      const [m15, h1, d1] = await Promise.all([
        this.fetchTimeframe(symbol, 'M15', start, end),
        this.fetchTimeframe(symbol, 'H1', htfStart, end),
        this.fetchTimeframe(symbol, 'D1', htfStart, end),
      ]);
      bundle[symbol] = { m15, h1, d1 };
      this.logger.log(
        `[${symbol}] loaded ${m15.length} M15 + ${h1.length} H1 + ${d1.length} D1 candles`,
      );
    }

    return bundle;
  }

  private async fetchTimeframe(
    symbol: string,
    timeframe: string,
    start: Date,
    end: Date,
  ): Promise<BacktestCandle[]> {
    const rows = await this.prisma.candle.findMany({
      where: {
        symbol,
        timeframe,
        openTime: { gte: start, lte: end },
      },
      orderBy: { openTime: 'asc' },
    });
    return rows.map((r) => ({
      symbol: r.symbol,
      timeframe: r.timeframe,
      openTime: r.openTime.toISOString(),
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
    }));
  }

  // ─── Read APIs ────────────────────────────────────────────────────────

  async listSessions(limit = 50) {
    return this.prisma.liveReplaySession.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async getSession(id: string) {
    return this.prisma.liveReplaySession.findUnique({ where: { id } });
  }

  async getTrades(sessionId: string) {
    return this.prisma.liveReplayTrade.findMany({
      where: { sessionId },
      orderBy: { openedAt: 'asc' },
    });
  }
}
