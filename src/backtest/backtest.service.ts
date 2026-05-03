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
    const symbol = dto.symbol ?? 'XAUUSD';

    // Create the run record (persist strategyVersion so the dashboard badge is accurate)
    const run = await this.prisma.backtestRun.create({
      data: {
        symbol,
        startDate: new Date(dto.startDate),
        endDate: new Date(dto.endDate),
        initialBalance: dto.initialBalance,
        riskPercent: dto.riskPercent,
        withLlm: dto.withLlm ?? false,
        strategyVersion: dto.strategyVersion ?? 'V6',
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
    const symbol = dto.symbol ?? 'XAUUSD';

    try {
      // Mark as running
      await this.prisma.backtestRun.update({
        where: { id: runId },
        data: { status: 'RUNNING' },
      });

      // HTF indicator warm-up — D1 ADX(14) + EMA50 both need ~50 bars of
      // history before they stabilize, otherwise the SMC engine sits on its
      // hands for the first 1-2 months of the requested range. Pre-fetch HTF
      // bars from `startDate − 90 days` so indicators are warm on day 1.
      // M15 stays at the requested start so the walk-forward is unaffected.
      const warmupDays = 90;
      const htfStart = new Date(dto.startDate);
      htfStart.setUTCDate(htfStart.getUTCDate() - warmupDays);
      const htfStartStr = htfStart.toISOString().slice(0, 10);

      // Fetch M15 at the requested range (the engine walks forward over these)
      const m15Candles = await this.fetchCandles(symbol, 'M15', dto.startDate, dto.endDate);
      this.logger.log(`Fetched ${m15Candles.length} ${symbol} M15 candles`);

      if (m15Candles.length < 200) {
        throw new Error(
          `Not enough M15 candles: ${m15Candles.length} (need at least 200)`,
        );
      }

      // H1 with warm-up for indicator stability + V6 regime detection
      const h1Candles = await this.fetchCandles(symbol, 'H1', htfStartStr, dto.endDate);
      this.logger.log(`Fetched ${h1Candles.length} ${symbol} H1 candles (incl. ${warmupDays}d warm-up)`);

      // V6 / V6-alt: pull H4/D1 with the same warm-up window so D1 ADX +
      // EMA50 are valid on day 1 of the M15 walk-forward.
      const strategyVersion = dto.strategyVersion ?? 'V6';
      let h4Candles: BacktestCandle[] = [];
      let d1Candles: BacktestCandle[] = [];
      if (strategyVersion !== 'V5.5b') {
        try {
          h4Candles = await this.fetchCandles(symbol, 'H4', htfStartStr, dto.endDate);
          d1Candles = await this.fetchCandles(symbol, 'D1', htfStartStr, dto.endDate);
          this.logger.log(`Fetched ${h4Candles.length} H4 + ${d1Candles.length} D1 candles (incl. ${warmupDays}d warm-up) for ${strategyVersion}`);
        } catch (e) {
          this.logger.warn(`Could not fetch H4/D1 for ${strategyVersion} — proceeding without HTF confluence: ${e.message}`);
        }
      }

      // Run the engine
      const engine = new BacktestEngine();
      const config: EngineConfig = {
        symbol,
        initialBalance: dto.initialBalance,
        riskPercent: dto.riskPercent,
        maxDailyLossPercent: 4.0,
        maxConsecutiveLosses: 5,
        maxOpenPositions: 4, // V6: raised from 3 to accommodate scale-ins
        strategyVersion,
      };

      const result = engine.run(m15Candles, h1Candles, config, { h4Candles, d1Candles });

      // Store trades
      if (result.trades.length > 0) {
        await this.prisma.backtestTrade.createMany({
          data: result.trades.map((t) => ({
            backtestRunId: runId,
            side: t.side,
            entryPrice: t.entryPrice,
            exitPrice: t.exitPrice,
            slPrice: t.slPrice,
            tpPrice: t.tpPrice ?? 0,
            lotSize: t.lotSize,
            pnl: t.pnl,
            commission: t.commission,
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
      const detail = error.response?.data?.detail || error.response?.data || error.message;
      const errorMessage = typeof detail === 'string' ? detail : JSON.stringify(detail);
      this.logger.error(`Backtest ${runId} failed: ${errorMessage}`, error.stack);

      await this.prisma.backtestRun.update({
        where: { id: runId },
        data: {
          status: 'FAILED',
          errorMessage,
          completedAt: new Date(),
        },
      });
      throw error;
    }
  }

  private async fetchCandles(
    symbol: string,
    timeframe: string,
    start: string,
    end: string,
  ): Promise<BacktestCandle[]> {
    const url = `${this.executionUrl}/historical-candles`;
    const res = await firstValueFrom(
      this.httpService.get<BacktestCandle[]>(url, {
        params: { symbol, timeframe, start, end },
      }),
    );
    return res.data;
  }

  async listRuns(limit = 50): Promise<BacktestRunResult[]> {
    const runs = await this.prisma.backtestRun.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return runs.map((run) => ({
      id: run.id,
      symbol: run.symbol,
      startDate: run.startDate.toISOString(),
      endDate: run.endDate.toISOString(),
      initialBalance: run.initialBalance,
      riskPercent: run.riskPercent,
      withLlm: run.withLlm,
      strategyVersion: run.strategyVersion ?? null,
      status: run.status,
      metrics: run.metrics as any,
      errorMessage: run.errorMessage,
      createdAt: run.createdAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
    }));
  }

  async getRun(id: string): Promise<BacktestRunResult | null> {
    const run = await this.prisma.backtestRun.findUnique({
      where: { id },
    });
    if (!run) return null;

    return {
      id: run.id,
      symbol: run.symbol,
      startDate: run.startDate.toISOString(),
      endDate: run.endDate.toISOString(),
      initialBalance: run.initialBalance,
      riskPercent: run.riskPercent,
      withLlm: run.withLlm,
      strategyVersion: run.strategyVersion ?? null,
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
      run.symbol,
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
      commission: t.commission,
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
