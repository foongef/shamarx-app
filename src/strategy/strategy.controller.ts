import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '@app/prisma';
import { RedisService } from '@app/redis';
import { SERVICE_URLS } from '@app/common';
import { Roles } from '../auth/guards/roles.guard';
import { LiveStrategyService } from './live/live-strategy.service';
import { PositionMonitorService } from './live/position-monitor.service';
import { LiveControlService } from './live/live-control.service';
import { LiveAnalyticsService } from './live/live-analytics.service';
import { StartLiveDto } from './dto/start-live.dto';
import { TestTradeDto } from './dto/test-trade.dto';

@ApiTags('Strategy')
@Controller('api/strategy')
export class StrategyController {
  constructor(
    private readonly live: LiveStrategyService,
    private readonly monitor: PositionMonitorService,
    private readonly control: LiveControlService,
    private readonly analytics: LiveAnalyticsService,
    private readonly httpService: HttpService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get('health')
  health() {
    return { status: 'ok', service: 'strategy' };
  }

  @Get('live/status')
  @ApiOperation({ summary: 'Live engine on/off + active config' })
  async status() {
    const status = this.control.status();
    let account = null;
    try {
      const res = await firstValueFrom(this.httpService.get(`${SERVICE_URLS.EXECUTION}/account`));
      account = res.data;
    } catch { /* ignore — broker may be down */ }
    return { ...status, account };
  }

  @Post('live/start')
  @Roles('SUPERADMIN')
  async start(@Body() dto: StartLiveDto) {
    // LiveControlService handles mode switch, optional mock reset, and equity capture
    // in the correct order — no extra work here.
    await this.control.start(dto);
    return this.control.status();
  }

  @Post('live/stop')
  @Roles('SUPERADMIN')
  async stop() {
    await this.control.stop();
    return this.control.status();
  }

  @Get('live/positions')
  @ApiOperation({ summary: 'Currently open positions across all pairs' })
  async openPositions() {
    try {
      const res = await firstValueFrom(this.httpService.get(`${SERVICE_URLS.EXECUTION}/positions`));
      return { positions: res.data || [] };
    } catch (err) {
      return { positions: [], error: (err as Error).message };
    }
  }

  @Get('live/candles')
  @ApiOperation({ summary: 'Recent candles for a symbol/timeframe (proxy)' })
  async candles(
    @Query('symbol') symbol: string,
    @Query('timeframe') timeframe = 'M15',
    @Query('count') count = '100',
  ) {
    try {
      const res = await firstValueFrom(
        this.httpService.get(`${SERVICE_URLS.EXECUTION}/candles`, {
          params: { symbol, timeframe, count: parseInt(count, 10) },
        }),
      );
      return { candles: res.data || [] };
    } catch (err) {
      return { candles: [], error: (err as Error).message };
    }
  }

  @Get('live/recent-trades')
  @ApiOperation({ summary: 'Last N closed live trades' })
  async recentTrades(@Query('limit') limit = '20') {
    const trades = await this.prisma.trade.findMany({
      where: { clientOrderId: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit, 10),
    });
    return { trades };
  }

  @Get('live/trades')
  @ApiOperation({ summary: 'Filterable, paginated live trade history' })
  async listTrades(
    @Query('status') status?: 'OPEN' | 'CLOSED' | 'PENDING' | 'ALL',
    @Query('symbol') symbol?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.analytics.listTrades({
      status,
      symbol,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      limit: limit ? parseInt(limit, 10) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
    });
  }

  @Get('live/stats')
  @ApiOperation({ summary: 'Aggregate live trading stats over the last N days' })
  async stats(@Query('days') days?: string) {
    return this.analytics.stats({ days: days ? parseInt(days, 10) : 30 });
  }

  @Get('live/equity-history')
  @ApiOperation({ summary: 'Equity curve points (1-min granularity)' })
  async equityHistory(
    @Query('hours') hours?: string,
    @Query('sessionId') sessionId?: string,
    @Query('mode') mode?: 'mock' | 'metaapi',
  ) {
    // If no explicit mode and no sessionId, scope to the current engine mode
    // so mock-test snapshots don't pollute the metaapi account arc.
    const effectiveMode = mode ?? (sessionId ? undefined : (this.control.getConfig()?.mode ?? undefined));
    return {
      points: await this.analytics.equityHistory({
        hours: hours ? parseInt(hours, 10) : undefined,
        sessionId,
        mode: effectiveMode,
      }),
    };
  }

  @Get('live/loop-health')
  @ApiOperation({
    summary:
      'Trading loop health — distinct from frontend chart polling. Shows whether the candle-ingestion → SMC-evaluation → broker-execution pipeline is alive.',
  })
  async loopHealth() {
    const pairs = (process.env.STRATEGY_PAIRS || 'XAUUSD,EURUSD,GBPUSD,USDJPY')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

    // Per-pair freshness: read the cron's heartbeat from Redis. The cron
    // writes `live:cron:last-poll:<symbol>:<timeframe>` on each successful
    // poll regardless of whether a new candle row was created. This is the
    // accurate "is the cron alive" signal.
    const candleAges = await Promise.all(
      pairs.map(async (sym) => {
        const lastPoll = await this.redis.get(`live:cron:last-poll:${sym}:M15`);
        const c = await this.prisma.candle.findFirst({
          where: { symbol: sym, timeframe: 'M15' },
          orderBy: { openTime: 'desc' },
          select: { openTime: true },
        });
        return {
          symbol: sym,
          lastCandleOpenTime: c?.openTime ?? null,
          lastIngestedAt: lastPoll,
          ageSec: lastPoll ? Math.round((Date.now() - new Date(lastPoll).getTime()) / 1000) : null,
        };
      }),
    );

    // Execution-service reachability
    let executionReachable = false;
    let metaApiMode = 'unknown';
    try {
      const res = await firstValueFrom(
        this.httpService.get(`${SERVICE_URLS.EXECUTION}/health`, { timeout: 5000 }),
      );
      executionReachable = true;
      metaApiMode = res.data?.mode ?? 'unknown';
    } catch { /* unreachable */ }

    // Health verdict: a healthy cron polls every 60s, so ingestion within
    // the last 2 minutes means the loop is alive. Allow a bit of slack
    // (3min) to absorb cron jitter and broker latency.
    const STALE_THRESHOLD_SEC = 3 * 60;
    const stalePairs = candleAges.filter(
      (c) => c.ageSec === null || c.ageSec > STALE_THRESHOLD_SEC,
    );
    const verdict =
      !executionReachable
        ? 'execution-service unreachable'
        : stalePairs.length === pairs.length
          ? 'no fresh candles for any pair'
          : stalePairs.length > 0
            ? `stale: ${stalePairs.map((s) => s.symbol).join(', ')}`
            : 'healthy';

    return {
      verdict,
      healthy: verdict === 'healthy',
      executionReachable,
      executionMode: metaApiMode,
      pairs: candleAges,
      checkedAt: new Date().toISOString(),
    };
  }

  @Get('live/sessions')
  @ApiOperation({ summary: 'List live engine sessions (each Start→Stop)' })
  async sessions(@Query('limit') limit?: string) {
    const sessions = await this.analytics.listSessions({
      limit: limit ? parseInt(limit, 10) : 50,
    });
    return { sessions };
  }

  @Get('live/sessions/:id')
  @ApiOperation({ summary: 'Single session detail (with live-recomputed counters)' })
  async getSession(@Param('id') id: string) {
    const session = await this.analytics.getSession(id);
    if (!session) return { session: null };
    return { session };
  }

  @Get('live/sessions/:id/trades')
  @ApiOperation({ summary: 'Trades for one session' })
  async sessionTrades(@Param('id') id: string) {
    return { trades: await this.analytics.sessionTrades(id) };
  }

  @Get('live/sessions/:id/stats')
  @ApiOperation({ summary: 'Aggregate stats for one session' })
  async sessionStats(@Param('id') id: string) {
    return this.analytics.sessionStats(id);
  }

  @Post('live/evaluate/:symbol')
  @Roles('SUPERADMIN')
  async triggerEvaluation(@Param('symbol') symbol: string) {
    const signal = await this.live.evaluatePair(symbol.toUpperCase());
    return { symbol: symbol.toUpperCase(), signal };
  }

  @Post('live/reconcile')
  @Roles('SUPERADMIN')
  async triggerReconcile() {
    await this.monitor.reconcileAll();
    return { ok: true };
  }

  @Post('live/test-trade')
  @Roles('SUPERADMIN')
  @ApiOperation({
    summary: 'Fire a synthetic trade through the full broker pipeline (admin debug)',
  })
  async fireTestTrade(@Body() dto: TestTradeDto) {
    const signal = await this.live.fireTestTrade({
      symbol: dto.symbol,
      side: dto.side,
      lotSize: dto.lotSize,
      slAtrMult: dto.slAtrMult,
      tpRMult: dto.tpRMult,
    });
    return { signal };
  }
}
