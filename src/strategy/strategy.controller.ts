import { Body, Controller, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '@app/prisma';
import { RedisService } from '@app/redis';
import { SERVICE_URLS } from '@app/common';
import { Public } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/guards/roles.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.service';
import { LiveStrategyService } from './live/live-strategy.service';
import { BrokerHttpClient } from './live/broker-http-client';
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
    private readonly brokerHttp: BrokerHttpClient,
  ) {}

  @Public()
  @Get('health')
  health() {
    return { status: 'ok', service: 'strategy' };
  }

  @Get('live/telemetry')
  @ApiOperation({
    summary: 'Engine Worker telemetry — per-pair last-eval, pending sweeps, recent events, daily counters',
  })
  telemetry() {
    return this.live.getTelemetry();
  }

  @Public()
  @Get('public/pulse')
  @ApiOperation({
    summary: 'Public pulse for the marketing landing page — per-pair lastEval + UTC counters only. No sensitive data.',
  })
  publicPulse() {
    return this.live.getPublicPulse();
  }

  @Get('live/status')
  @ApiOperation({ summary: 'Live engine on/off + active config' })
  async status(@CurrentUser() me: AuthenticatedUser) {
    const status = this.control.status();

    // TENANCY: the `account` fields describe the PLATFORM-DEFAULT MetaApi
    // connection (the house account) — legacy single-account view. Exposing
    // it to every authenticated user leaked the owner's equity/balance to
    // other tenants. Engine on/off + config stay visible to everyone (the
    // engine is shared); account money is SUPERADMIN-only. Regular users see
    // their own accounts via /live/accounts/:id/overview (ownership-checked).
    if (me.role !== 'SUPERADMIN') {
      return { ...status, account: null, accountStale: null };
    }

    let account = null;
    try {
      const res = await firstValueFrom(this.httpService.get(`${SERVICE_URLS.EXECUTION}/account`));
      account = res.data;
    } catch { /* broker unreachable — surfaced via accountStale below */ }

    // Broker unreachable → serve the last-known-good reading so the UI can
    // show a dimmed stale value + timestamp instead of pretending it's $0.00.
    let accountStale = null;
    if (!account) {
      // Scope to the METAAPI-broker account: `mode` records the engine
      // config (stamped on every account's snapshot), not the broker — the
      // newest mode='metaapi' row may belong to a cTrader account.
      const snap = await this.prisma.equitySnapshot.findFirst({
        where: { source: 'live', mode: 'metaapi', account: { broker: 'METAAPI' } },
        orderBy: { takenAt: 'desc' },
        select: { balance: true, equity: true, openPositions: true, takenAt: true },
      });
      if (snap) {
        accountStale = {
          balance: snap.balance,
          equity: snap.equity,
          openPositions: snap.openPositions,
          at: snap.takenAt,
        };
      }
    }
    return { ...status, account, accountStale };
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
  @ApiOperation({ summary: 'Open positions on the platform-default account (house view)' })
  async openPositions(@CurrentUser() me: AuthenticatedUser) {
    // TENANCY: this is the legacy global endpoint — the DEFAULT MetaApi
    // account's positions, i.e. the house account. Users get their own
    // positions via /live/accounts/:id/overview.
    if (me.role !== 'SUPERADMIN') return { positions: [] };
    try {
      const res = await firstValueFrom(this.httpService.get(`${SERVICE_URLS.EXECUTION}/positions`));
      return { positions: res.data || [] };
    } catch (err) {
      return { positions: [], error: (err as Error).message };
    }
  }

  @Get('live/candles')
  @ApiOperation({ summary: 'Recent candles for a symbol/timeframe' })
  async candles(
    @Query('symbol') symbol: string,
    @Query('timeframe') timeframe = 'M15',
    @Query('count') count = '100',
  ) {
    const take = Math.min(parseInt(count, 10) || 100, 1000);
    // Serve from the Candle table — the engine's single source of truth.
    // A live broker fetch here would blank the chart whenever brokers are
    // down, which is exactly when you want to SEE the last data.
    const rows = await this.prisma.candle.findMany({
      where: { symbol: (symbol || '').toUpperCase(), timeframe },
      orderBy: { openTime: 'desc' },
      take,
    });
    if (rows.length > 0) {
      return {
        candles: rows.reverse().map((r) => ({
          symbol: r.symbol,
          timeframe: r.timeframe,
          openTime: r.openTime.toISOString(),
          open: r.open,
          high: r.high,
          low: r.low,
          close: r.close,
          volume: r.volume,
        })),
      };
    }
    // Table empty for this symbol/timeframe (e.g. fresh install) — fall back
    // to a direct broker fetch.
    try {
      const res = await firstValueFrom(
        this.httpService.get(`${SERVICE_URLS.EXECUTION}/candles`, {
          params: { symbol, timeframe, count: take },
        }),
      );
      return { candles: res.data || [] };
    } catch (err) {
      return { candles: [], error: (err as Error).message };
    }
  }

  @Get('live/recent-trades')
  @ApiOperation({ summary: 'Last N closed live trades' })
  async recentTrades(
    @CurrentUser() me: AuthenticatedUser,
    @Query('limit') limit = '20',
  ) {
    const trades = await this.prisma.trade.findMany({
      where: { clientOrderId: { not: null }, account: { userId: me.id } },
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit, 10),
    });
    return { trades };
  }

  @Get('live/trades')
  @ApiOperation({ summary: 'Filterable, paginated live trade history' })
  async listTrades(
    @CurrentUser() me: AuthenticatedUser,
    @Query('status') status?: 'OPEN' | 'CLOSED' | 'PENDING' | 'ALL',
    @Query('symbol') symbol?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.analytics.listTrades({
      userId: me.id,
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
  async stats(
    @CurrentUser() me: AuthenticatedUser,
    @Query('days') days?: string,
  ) {
    return this.analytics.stats({ userId: me.id, days: days ? parseInt(days, 10) : 30 });
  }

  @Get('live/equity-history')
  @ApiOperation({ summary: 'Equity curve points (1-min granularity)' })
  async equityHistory(
    @CurrentUser() me: AuthenticatedUser,
    @Query('hours') hours?: string,
    @Query('sessionId') sessionId?: string,
    @Query('mode') mode?: 'mock' | 'metaapi',
    @Query('accountId') accountId?: string,
  ) {
    // If no explicit mode and no sessionId, scope to the current engine mode
    // so mock-test snapshots don't pollute the metaapi account arc.
    const effectiveMode = mode ?? (sessionId ? undefined : (this.control.getConfig()?.mode ?? undefined));
    return {
      points: await this.analytics.equityHistory({
        userId: me.id,
        hours: hours ? parseInt(hours, 10) : undefined,
        sessionId,
        mode: effectiveMode,
        accountId,
      }),
    };
  }

  @Get('live/loop-health')
  @ApiOperation({
    summary:
      'Trading loop health — distinct from frontend chart polling. Shows whether the candle-ingestion → SMC-evaluation → broker-execution pipeline is alive.',
  })
  async loopHealth(@CurrentUser() me: AuthenticatedUser) {
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

    // Candle-source failover: the execution service sets a 5-min-TTL redis
    // flag per symbol/timeframe whenever it serves candles from the fallback
    // (cTrader trendbars) instead of the primary MetaApi feed.
    const fallbackPairs: string[] = [];
    for (const sym of pairs) {
      const flag =
        (await this.redis.get(`live:candle-fallback:${sym}:M15`)) ??
        (await this.redis.get(`live:candle-fallback:${sym}:H1`));
      if (flag) fallbackPairs.push(sym);
    }

    // Per-account broker connectivity, derived from the equity-snapshot cron
    // (1/min per enabled account; skipped on broker failure — so a growing
    // age means the broker is unreachable). Only meaningful while the engine
    // is running: snapshots pause when it's stopped.
    const engineRunning = this.control.isRunning();
    // TENANCY: users see connectivity for THEIR accounts only; SUPERADMIN
    // sees the whole fleet.
    const enabledAccounts = await this.prisma.brokerAccount.findMany({
      where: {
        isEnabled: true,
        ...(me.role === 'SUPERADMIN' ? {} : { userId: me.id }),
      },
      select: { id: true, name: true, broker: true },
    });
    const ACCOUNT_STALE_SEC = 3 * 60;
    const accounts = await Promise.all(
      enabledAccounts.map(async (a) => {
        const snap = await this.prisma.equitySnapshot.findFirst({
          where: { accountId: a.id },
          orderBy: { takenAt: 'desc' },
          select: { takenAt: true },
        });
        const ageSec = snap
          ? Math.round((Date.now() - snap.takenAt.getTime()) / 1000)
          : null;
        return {
          ...a,
          lastSeenAt: snap?.takenAt ?? null,
          connected: engineRunning
            ? ageSec !== null && ageSec <= ACCOUNT_STALE_SEC
            : null, // engine stopped — connectivity unknown, don't cry wolf
        };
      }),
    );
    const unreachable = accounts.filter((a) => a.connected === false);

    // Health verdict: a healthy cron polls every 60s, so ingestion within
    // the last 2 minutes means the loop is alive. Allow a bit of slack
    // (3min) to absorb cron jitter and broker latency.
    const STALE_THRESHOLD_SEC = 3 * 60;
    const stalePairs = candleAges.filter(
      (c) => c.ageSec === null || c.ageSec > STALE_THRESHOLD_SEC,
    );

    // Three states: unhealthy = the loop itself is broken (no candles / no
    // execution service); degraded = trading continues but something needs
    // attention (candles on fallback feed, or a broker unreachable).
    const unhealthyReason =
      !executionReachable
        ? 'execution-service unreachable'
        : stalePairs.length === pairs.length
          ? 'no fresh candles for any pair'
          : stalePairs.length > 0
            ? `stale: ${stalePairs.map((s) => s.symbol).join(', ')}`
            : null;
    const degradedReasons: string[] = [];
    if (fallbackPairs.length > 0) {
      degradedReasons.push('candles on fallback feed (MetaApi down)');
    }
    for (const a of unreachable) {
      degradedReasons.push(`${a.name} unreachable`);
    }

    const health: 'healthy' | 'degraded' | 'unhealthy' = unhealthyReason
      ? 'unhealthy'
      : degradedReasons.length > 0
        ? 'degraded'
        : 'healthy';
    const verdict = unhealthyReason ?? (degradedReasons.join(' · ') || 'healthy');

    return {
      verdict,
      health,
      healthy: health === 'healthy', // kept for backward compat
      executionReachable,
      executionMode: metaApiMode,
      pairs: candleAges,
      candleFallback: fallbackPairs,
      accounts,
      checkedAt: new Date().toISOString(),
    };
  }

  @Get('live/sessions')
  @ApiOperation({ summary: 'List live engine sessions (each Start→Stop)' })
  async sessions(
    @CurrentUser() me: AuthenticatedUser,
    @Query('limit') limit?: string,
  ) {
    const sessions = await this.analytics.listSessions({
      userId: me.id,
      isAdmin: me.role === 'SUPERADMIN',
      limit: limit ? parseInt(limit, 10) : 50,
    });
    return { sessions };
  }

  @Get('live/sessions/:id')
  @ApiOperation({ summary: 'Single session detail (with live-recomputed counters)' })
  async getSession(
    @CurrentUser() me: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    const session = await this.analytics.getSession(me.id, id, me.role === 'SUPERADMIN');
    if (!session) return { session: null };
    return { session };
  }

  @Get('live/sessions/:id/trades')
  @ApiOperation({ summary: 'Trades for one session (optionally one account)' })
  async sessionTrades(
    @CurrentUser() me: AuthenticatedUser,
    @Param('id') id: string,
    @Query('accountId') accountId?: string,
  ) {
    return { trades: await this.analytics.sessionTrades(me.id, id, accountId) };
  }

  @Get('live/sessions/:id/stats')
  @ApiOperation({ summary: 'Aggregate stats for one session (optionally one account)' })
  async sessionStats(
    @CurrentUser() me: AuthenticatedUser,
    @Param('id') id: string,
    @Query('accountId') accountId?: string,
  ) {
    return this.analytics.sessionStats(me.id, id, accountId);
  }

  @Get('live/accounts/:accountId/overview')
  @ApiOperation({
    summary:
      'Per-account live snapshot: broker account info + open positions, with last-known-good fallback when the broker is unreachable',
  })
  async accountOverview(
    @CurrentUser() me: AuthenticatedUser,
    @Param('accountId') accountId: string,
  ) {
    const acct = await this.prisma.brokerAccount.findFirst({
      where: { id: accountId, userId: me.id },
      select: { id: true, name: true, broker: true, isEnabled: true },
    });
    if (!acct) throw new NotFoundException(`BrokerAccount ${accountId} not found`);

    let live = null;
    let positions: unknown[] = [];
    try {
      live = await this.brokerHttp.fetchAccount(accountId);
      positions = await this.brokerHttp.fetchOpenPositions(accountId);
    } catch { /* broker unreachable — stale fallback below */ }

    let accountStale = null;
    if (!live) {
      const snap = await this.prisma.equitySnapshot.findFirst({
        where: { accountId },
        orderBy: { takenAt: 'desc' },
        select: { balance: true, equity: true, openPositions: true, takenAt: true },
      });
      if (snap) {
        accountStale = {
          balance: snap.balance,
          equity: snap.equity,
          openPositions: snap.openPositions,
          at: snap.takenAt,
        };
      }
    }
    return { account: acct, live, positions, accountStale };
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
