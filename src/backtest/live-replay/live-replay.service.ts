import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@app/prisma';
import { Worker } from 'node:worker_threads';
import * as path from 'node:path';
import { LiveSmcOrchestrator } from '../../strategy/live/live-smc-orchestrator';
import { ReplayEngine, CandleBundle, ReplayResult } from './replay-engine';
import { StartReplayDto, REPLAY_DEFAULT_PAIRS } from './dto/start-replay.dto';
import { BacktestCandle } from '../engine/types';
import type { ParentMessage, WorkerMessage } from './worker-protocol';

const HTF_WARMUP_DAYS = 90;

// Worker safety net — if the replay hangs (shouldn't, but defense in depth)
// we kill the thread after 30 min and mark the session FAILED.
const WORKER_TIMEOUT_MS = 30 * 60 * 1000;

// Set REPLAY_USE_WORKER=0 to fall back to in-thread execution (debug aid).
const USE_WORKER = process.env.REPLAY_USE_WORKER !== '0';

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

      const cfg = {
        startDate: dto.startDate,
        endDate: dto.endDate,
        initialBalance: dto.initialBalance,
        riskPercent: dto.riskPercent,
        pairs,
      };

      // Run on a worker thread so the live-trading thread (NestJS event loop)
      // stays responsive. Falls back to in-thread if REPLAY_USE_WORKER=0
      // (debugging aid — easier to inspect when running locally).
      const result = USE_WORKER
        ? await this.runOnWorker(sessionId, cfg, candles)
        : await new ReplayEngine(this.orchestrator).run(cfg, candles);

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
            sweptLevel: t.sweptLevel ?? null,
            sweptHigh: t.sweptHigh ?? null,
            sweptLow: t.sweptLow ?? null,
            sweepCandleTime: t.sweepCandleTime ? new Date(t.sweepCandleTime) : null,
            d1Bias: t.d1Bias ?? null,
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
   * Spawn replay-worker.js on a worker thread, ship the candle bundle in,
   * stream progress back, and resolve with the ReplayResult. The worker is
   * always terminated in finally so we never leak threads — even on errors,
   * timeouts, or unexpected exits.
   *
   * Path resolution: __dirname at runtime is dist/backtest/live-replay/, and
   * tsc emits replay-worker.js as a sibling there. In the dev TS build we
   * still resolve the .js path, which works because nest build emits both.
   */
  private runOnWorker(
    sessionId: string,
    cfg: Parameters<ReplayEngine['run']>[0],
    candles: CandleBundle,
  ): Promise<ReplayResult> {
    const workerPath = path.resolve(__dirname, 'replay-worker.js');
    const worker = new Worker(workerPath);

    return new Promise<ReplayResult>((resolve, reject) => {
      let timeout: NodeJS.Timeout | null = setTimeout(() => {
        timeout = null;
        worker.terminate().catch(() => {});
        reject(new Error(`Replay worker timed out after ${WORKER_TIMEOUT_MS / 60000} min`));
      }, WORKER_TIMEOUT_MS);

      const cleanup = () => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
        worker.terminate().catch(() => {});
      };

      worker.on('message', (msg: WorkerMessage) => {
        switch (msg.type) {
          case 'progress':
            // Best-effort progress write; never blocks the worker.
            this.prisma.liveReplaySession
              .update({
                where: { id: sessionId },
                data: { progress: Math.round((msg.processed / msg.total) * 100) },
              })
              .catch(() => {/* progress writes are non-critical */});
            break;
          case 'done':
            cleanup();
            resolve(msg.result);
            break;
          case 'error':
            cleanup();
            reject(new Error(msg.message + (msg.stack ? `\n${msg.stack}` : '')));
            break;
        }
      });

      worker.on('error', (err) => {
        cleanup();
        reject(err);
      });

      worker.on('exit', (code) => {
        if (code !== 0 && timeout !== null) {
          // Exited without sending 'done' or 'error' — likely OOM-killed.
          cleanup();
          reject(new Error(`Replay worker exited with code ${code}`));
        }
      });

      const startMsg: ParentMessage = { type: 'run', cfg, candles };
      worker.postMessage(startMsg);
    });
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
