import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@app/prisma';
import { firstValueFrom } from 'rxjs';
import { BacktestEngine } from './engine/backtest-engine';
import { BacktestCandle, EngineConfig } from './engine/types';
import { CreateBacktestDto } from './dto/create-backtest.dto';
import { BacktestRunResult, BacktestTradeResult } from './dto/backtest-result.dto';

@Injectable()
export class BacktestService {
  private readonly logger = new Logger(BacktestService.name);
  private readonly executionUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.executionUrl =
      this.configService.get('EXECUTION_SERVICE_URL') || 'http://localhost:8000';
  }

  async createAndRun(dto: CreateBacktestDto): Promise<{ id: string; status: string }> {
    // Create the run record
    const run = await this.prisma.backtestRun.create({
      data: {
        startDate: new Date(dto.startDate),
        endDate: new Date(dto.endDate),
        initialBalance: dto.initialBalance,
        riskPercent: dto.riskPercent,
        withLlm: dto.withLlm ?? false,
        status: 'PENDING',
      },
    });

    // Run asynchronously
    this.executeBacktest(run.id, dto).catch((err) => {
      this.logger.error(`Backtest ${run.id} failed: ${err.message}`);
    });

    return { id: run.id, status: 'PENDING' };
  }

  private async executeBacktest(runId: string, dto: CreateBacktestDto): Promise<void> {
    try {
      // Mark as running
      await this.prisma.backtestRun.update({
        where: { id: runId },
        data: { status: 'RUNNING' },
      });

      // Fetch historical M15 candles
      const m15Candles = await this.fetchCandles('M15', dto.startDate, dto.endDate);
      this.logger.log(`Fetched ${m15Candles.length} M15 candles`);

      if (m15Candles.length < 200) {
        throw new Error(
          `Not enough M15 candles: ${m15Candles.length} (need at least 200)`,
        );
      }

      // Fetch historical H1 candles (broader range for indicator warmup)
      const h1Candles = await this.fetchCandles('H1', dto.startDate, dto.endDate);
      this.logger.log(`Fetched ${h1Candles.length} H1 candles`);

      // Run the engine
      const engine = new BacktestEngine();
      const config: EngineConfig = {
        initialBalance: dto.initialBalance,
        riskPercent: dto.riskPercent,
        maxDailyLossPercent: 3.0,
        maxConsecutiveLosses: 3,
        maxOpenPositions: 3,
      };

      const result = engine.run(m15Candles, h1Candles, config);

      // Store trades
      if (result.trades.length > 0) {
        await this.prisma.backtestTrade.createMany({
          data: result.trades.map((t) => ({
            backtestRunId: runId,
            side: t.side,
            entryPrice: t.entryPrice,
            exitPrice: t.exitPrice,
            slPrice: t.slPrice,
            tpPrice: t.tpPrice,
            lotSize: t.lotSize,
            pnl: t.pnl,
            setupTags: t.setupTags,
            entryTime: new Date(t.entryTime),
            exitTime: new Date(t.exitTime),
            exitReason: t.exitReason,
            h1Bias: t.h1Bias,
            rsiAtEntry: t.rsiAtEntry,
            atrAtEntry: t.atrAtEntry,
          })),
        });
      }

      // Mark as completed with metrics
      await this.prisma.backtestRun.update({
        where: { id: runId },
        data: {
          status: 'COMPLETED',
          metrics: result.metrics as any,
          completedAt: new Date(),
        },
      });

      this.logger.log(`Backtest ${runId} completed: ${result.metrics.totalTrades} trades`);
    } catch (error) {
      await this.prisma.backtestRun.update({
        where: { id: runId },
        data: {
          status: 'FAILED',
          errorMessage: error.message,
          completedAt: new Date(),
        },
      });
      throw error;
    }
  }

  private async fetchCandles(
    timeframe: string,
    start: string,
    end: string,
  ): Promise<BacktestCandle[]> {
    const url = `${this.executionUrl}/historical-candles`;
    const res = await firstValueFrom(
      this.httpService.get<BacktestCandle[]>(url, {
        params: { symbol: 'XAUUSD', timeframe, start, end },
      }),
    );
    return res.data;
  }

  async getRun(id: string): Promise<BacktestRunResult | null> {
    const run = await this.prisma.backtestRun.findUnique({
      where: { id },
    });
    if (!run) return null;

    return {
      id: run.id,
      startDate: run.startDate.toISOString(),
      endDate: run.endDate.toISOString(),
      initialBalance: run.initialBalance,
      riskPercent: run.riskPercent,
      withLlm: run.withLlm,
      status: run.status,
      metrics: run.metrics as any,
      errorMessage: run.errorMessage,
      createdAt: run.createdAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
    };
  }

  async getCandles(runId: string): Promise<BacktestCandle[] | null> {
    const run = await this.prisma.backtestRun.findUnique({
      where: { id: runId },
    });
    if (!run) return null;

    const candles = await this.fetchCandles(
      'M15',
      run.startDate.toISOString().split('T')[0],
      run.endDate.toISOString().split('T')[0],
    );

    return candles.map((c) => ({
      symbol: c.symbol,
      timeframe: c.timeframe,
      openTime: c.openTime,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));
  }

  async getTrades(runId: string): Promise<BacktestTradeResult[] | null> {
    const run = await this.prisma.backtestRun.findUnique({
      where: { id: runId },
    });
    if (!run) return null;

    const trades = await this.prisma.backtestTrade.findMany({
      where: { backtestRunId: runId },
      orderBy: { entryTime: 'asc' },
    });

    return trades.map((t) => ({
      id: t.id,
      side: t.side,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      slPrice: t.slPrice,
      tpPrice: t.tpPrice,
      lotSize: t.lotSize,
      pnl: t.pnl,
      setupTags: t.setupTags,
      entryTime: t.entryTime.toISOString(),
      exitTime: t.exitTime.toISOString(),
      exitReason: t.exitReason,
      h1Bias: t.h1Bias,
      rsiAtEntry: t.rsiAtEntry,
      atrAtEntry: t.atrAtEntry,
    }));
  }
}
