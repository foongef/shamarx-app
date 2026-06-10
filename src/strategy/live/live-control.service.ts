/**
 * Runtime on/off switch for the live engine.
 *
 * `LIVE_MODE` env is the COMPILE-TIME enabling flag — when false, the live
 * services don't even subscribe to candle events. This service is the
 * RUNTIME flag — when running=false, candle events arrive but are ignored.
 *
 * State is persisted to Redis so toggling survives container restart.
 */
import { Injectable, Logger, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '@app/prisma';
import { RedisService } from '@app/redis';
import { SERVICE_URLS } from '@app/common';
import { PositionMonitorService } from './position-monitor.service';

const REDIS_KEY_RUNNING = 'live:engine:running';
const REDIS_KEY_CONFIG = 'live:engine:config';
const REDIS_KEY_MODE = 'live:engine:mode';
const REDIS_KEY_SESSION = 'live:engine:session';
const REDIS_KEY_LAST_CHANGED = 'live:engine:last-changed-at';

export interface LiveEngineConfig {
  /** 'GIDEON' is canonical; 'SMC-V2' / 'V6-alt' kept as legacy aliases. */
  strategyVersion: 'GIDEON' | 'SMC-V2' | 'V6-alt';
  riskPercent: number;
  mode: 'mock' | 'metaapi';
  /** Mock starting balance — only meaningful when mode='mock'. */
  mockBalance?: number;
}

@Injectable()
export class LiveControlService implements OnModuleInit {
  private readonly logger = new Logger(LiveControlService.name);
  private running = false;
  private lastChangedAt: string | null = null;
  private config: LiveEngineConfig | null = null;
  private currentSessionId: string | null = null;

  constructor(
    private readonly redis: RedisService,
    private readonly configSvc: ConfigService,
    private readonly prisma: PrismaService,
    private readonly httpService: HttpService,
    @Inject(forwardRef(() => PositionMonitorService))
    private readonly monitor: PositionMonitorService,
  ) {}

  async onModuleInit() {
    const enabled = (this.configSvc.get<string>('LIVE_MODE') || 'false').toLowerCase() === 'true';
    if (!enabled) {
      this.running = false;
      return;
    }
    // LIVE_MODE=true → respect persisted runtime flag (default: paused)
    try {
      const persisted = await this.redis.get(REDIS_KEY_RUNNING);
      this.running = persisted === '1';
      const cfgRaw = await this.redis.get(REDIS_KEY_CONFIG);
      if (cfgRaw) this.config = JSON.parse(cfgRaw) as LiveEngineConfig;
      const sid = await this.redis.get(REDIS_KEY_SESSION);
      if (sid) this.currentSessionId = sid;
      // Restore the original Start moment so the duration counter survives restarts
      const lastAt = await this.redis.get(REDIS_KEY_LAST_CHANGED);
      if (lastAt) this.lastChangedAt = lastAt;
    } catch {
      this.running = false;
    }
    this.logger.log(`Live engine boot — running=${this.running}, sessionId=${this.currentSessionId}, lastChangedAt=${this.lastChangedAt}`);
  }

  /** Compile-time check — has LIVE_MODE been enabled at boot? */
  isEnabled(): boolean {
    return (this.configSvc.get<string>('LIVE_MODE') || 'false').toLowerCase() === 'true';
  }

  /** Runtime check — should we actually trade right now? */
  isRunning(): boolean {
    return this.isEnabled() && this.running;
  }

  /** Validate + persist config; return normalized config. */
  validateConfig(input: Partial<LiveEngineConfig>): LiveEngineConfig {
    const strategy = input.strategyVersion ?? 'GIDEON';
    if (strategy !== 'GIDEON' && strategy !== 'SMC-V2' && strategy !== 'V6-alt') {
      throw new Error(`Unsupported strategy: ${strategy}. Live engine supports SMC-V2 (legacy alias: V6-alt).`);
    }
    const risk = Number(input.riskPercent);
    if (!isFinite(risk) || risk < 0.25 || risk > 4.0) {
      throw new Error('riskPercent must be between 0.25 and 4.0');
    }
    const mode = input.mode === 'metaapi' ? 'metaapi' : 'mock';

    // For mock mode: only reset balance if the caller EXPLICITLY provided one.
    // Otherwise we leave the existing mock account untouched (so consecutive
    // sessions can compound on each other instead of always rebooting to $10k).
    let mockBalance: number | undefined;
    if (mode === 'mock' && input.mockBalance !== undefined && input.mockBalance !== null) {
      const n = Number(input.mockBalance);
      if (!isFinite(n) || n < 50 || n > 1_000_000) {
        throw new Error('mockBalance must be between 50 and 1,000,000');
      }
      mockBalance = n;
    }

    if (mode === 'metaapi' && !process.env.METAAPI_ACCOUNT_ID_DEMO) {
      throw new Error('Cannot start in MetaApi mode — METAAPI_ACCOUNT_ID_DEMO not set in .env');
    }
    return { strategyVersion: 'GIDEON', riskPercent: risk, mode, mockBalance };
  }

  async start(input: Partial<LiveEngineConfig>): Promise<LiveEngineConfig> {
    if (!this.isEnabled()) {
      throw new Error('LIVE_MODE=false in env — set LIVE_MODE=true and restart to enable');
    }

    // Safety: refuse to start if there's already an active session. The user
    // (or an accidental double-click) must stop the current session first —
    // this prevents silently nuking a live MetaApi session.
    if (this.running && this.currentSessionId) {
      throw new Error(
        `A live session is already running (${this.currentSessionId.slice(0, 8)}). Stop it first before starting a new one.`,
      );
    }

    const cfg = this.validateConfig(input);

    // True-orphan cleanup: only crash DB rows that are RUNNING but NOT the
    // current Redis session. This handles the legit crash-recovery case
    // (NestJS died mid-session leaving a stale row) without ever stomping on
    // an actively-running session.
    const orphanFilter = this.currentSessionId
      ? { status: 'RUNNING', NOT: { id: this.currentSessionId } }
      : { status: 'RUNNING' };
    const orphans = await this.prisma.liveSession.updateMany({
      where: orphanFilter,
      data: { status: 'CRASHED', endedAt: new Date() },
    });
    if (orphans.count > 0) {
      this.logger.warn(`Marked ${orphans.count} orphan session(s) as CRASHED (no matching runtime state)`);
    }

    // CRITICAL: switch the execution-service mode override BEFORE fetching equity.
    // Otherwise we'd capture the OLD mode's balance as startEquity (e.g. mock $5k
    // when the user actually picked metaapi → real $1k), producing a phantom
    // session Δ. Redis is the single source of truth read by execution-service.
    await this.redis.set(REDIS_KEY_MODE, cfg.mode);

    // If the user explicitly opted to reset the mock balance, do it BEFORE we
    // capture startEquity so the captured value reflects the new starting point.
    if (cfg.mode === 'mock' && cfg.mockBalance !== undefined) {
      try {
        await firstValueFrom(
          this.httpService.post(`${SERVICE_URLS.EXECUTION}/account/mock/reset`, {
            balance: cfg.mockBalance,
          }),
        );
      } catch (err) {
        this.logger.warn(`Mock reset to $${cfg.mockBalance} failed: ${(err as Error).message}`);
      }
    }

    // Snapshot starting equity from broker — now routed to the correct backend
    // and reflecting any reset we just did.
    let startEquity: number = cfg.mockBalance ?? 0;
    try {
      const acc = await firstValueFrom(this.httpService.get(`${SERVICE_URLS.EXECUTION}/account`));
      const equity = acc.data?.equity;
      if (typeof equity === 'number' && isFinite(equity)) {
        startEquity = equity;
      }
    } catch {
      this.logger.warn(`Could not fetch starting equity from broker — defaulting to ${startEquity}`);
    }

    const pairs = (this.configSvc.get<string>('STRATEGY_PAIRS') || 'XAUUSD,EURUSD,GBPUSD,USDJPY')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

    const session = await this.prisma.liveSession.create({
      data: {
        strategyVersion: cfg.strategyVersion,
        riskPercent: cfg.riskPercent,
        mode: cfg.mode,
        mockBalance: cfg.mockBalance ?? null,
        startEquity,
        pairs,
        status: 'RUNNING',
      },
    });

    this.currentSessionId = session.id;
    this.config = cfg;
    this.running = true;
    this.lastChangedAt = new Date().toISOString();

    await this.redis.set(REDIS_KEY_RUNNING, '1');
    await this.redis.set(REDIS_KEY_CONFIG, JSON.stringify(cfg));
    await this.redis.set(REDIS_KEY_SESSION, session.id);
    await this.redis.set(REDIS_KEY_LAST_CHANGED, this.lastChangedAt);

    this.logger.log(`Live engine STARTED — sessionId=${session.id} strategy=${cfg.strategyVersion} mode=${cfg.mode} risk=${cfg.riskPercent}% mockBal=${cfg.mockBalance ?? '—'} startEquity=$${startEquity}`);
    return cfg;
  }

  async stop(): Promise<void> {
    // Final reconcile BEFORE we mark ourselves stopped. The position monitor
    // skips while running=false, so without this any trades the broker has
    // already closed (e.g. SL/TP hit during this session) would stay marked
    // OPEN in our DB forever.
    try {
      await this.monitor.reconcileAll();
    } catch (err) {
      this.logger.warn(`Final reconcile during stop() failed: ${(err as Error).message}`);
    }

    this.running = false;
    this.lastChangedAt = new Date().toISOString();
    try {
      await this.redis.set(REDIS_KEY_RUNNING, '0');
      await this.redis.set(REDIS_KEY_LAST_CHANGED, this.lastChangedAt);
    } catch { /* ignore */ }

    // Finalize the current session.
    if (this.currentSessionId) {
      try {
        let endEquity: number | null = null;
        try {
          const acc = await firstValueFrom(this.httpService.get(`${SERVICE_URLS.EXECUTION}/account`));
          endEquity = acc.data?.equity ?? null;
        } catch { /* ignore */ }

        const trades = await this.prisma.trade.findMany({
          where: { sessionId: this.currentSessionId },
          select: { pnl: true, status: true },
        });
        const realized = trades
          .filter((t) => t.status === 'CLOSED' && t.pnl !== null)
          .reduce((s, t) => s + (t.pnl ?? 0), 0);
        const wins = trades.filter((t) => t.status === 'CLOSED' && (t.pnl ?? 0) > 0).length;
        const losses = trades.filter((t) => t.status === 'CLOSED' && (t.pnl ?? 0) < 0).length;

        await this.prisma.liveSession.update({
          where: { id: this.currentSessionId },
          data: {
            status: 'ENDED',
            endedAt: new Date(),
            endEquity,
            realizedPnl: Math.round(realized * 100) / 100,
            tradesCount: trades.length,
            winsCount: wins,
            lossesCount: losses,
          },
        });
        this.logger.log(`Session ${this.currentSessionId} finalized — realized=$${realized.toFixed(2)} trades=${trades.length}`);
      } catch (err) {
        this.logger.warn(`Session finalize failed: ${(err as Error).message}`);
      }
    }
    this.currentSessionId = null;
    try {
      await this.redis.del(REDIS_KEY_SESSION);
    } catch { /* ignore */ }

    this.logger.log('Live engine STOPPED');
  }

  /** Current session id — used by LiveStrategyService to tag new trades. */
  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  /** Risk used by live evaluator — runtime config overrides env. */
  getRiskPercent(): number {
    return this.config?.riskPercent ?? parseFloat(this.configSvc.get<string>('RISK_PERCENT') || '1.5');
  }

  getConfig(): LiveEngineConfig | null {
    return this.config;
  }

  status() {
    return {
      enabled: this.isEnabled(),
      running: this.isRunning(),
      mt5Mode: this.config?.mode ?? this.configSvc.get<string>('MT5_MODE') ?? 'mock',
      pairs: (this.configSvc.get<string>('STRATEGY_PAIRS') || 'XAUUSD,EURUSD,GBPUSD,USDJPY')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
      riskPercent: this.getRiskPercent(),
      strategyVersion: this.config?.strategyVersion ?? 'GIDEON',
      mockBalance: this.config?.mockBalance ?? null,
      lastChangedAt: this.lastChangedAt,
    };
  }
}
