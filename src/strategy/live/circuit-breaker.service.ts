/**
 * CircuitBreakerService — the ONE adaptive component that survived Phase 3.
 *
 * Walk-forward falsified performance-based sleeve RE-ENTRY timing, but every
 * variant's PROTECTIVE half cut drawdowns dramatically. So we ship only that
 * half: when rolling realized PnL over ROLLING_DAYS breaches the threshold,
 * new entries pause engine-wide and the admin is emailed. Open positions
 * keep being managed to their natural exits — never abandoned. Resumption is
 * MANUAL (admin reset): humans own re-entry timing, because machines
 * demonstrably don't (design 2015-21 grid +$205 → validation 2021-25 −$29
 * vs +$711 all-on).
 *
 * Threshold semantics: realized PnL across REAL fills only (CLOSED, non-ORPHAN)
 * summed over the trailing window, compared to -(CIRCUIT_BREAKER_LOSS_PCT% of
 * current total equity). Defaults: 60 days, 15% → trips on sustained regime
 * bleed (2022-24 style, or Apr-Jul 2026's -$224 slump) while normal monthly
 * variance (±$100 on $1k) stays well inside.
 *
 * State lives in Redis (survives restarts). Kill-switch: CIRCUIT_BREAKER=false.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@app/prisma';
import { RedisService } from '@app/redis';
import { MailService } from '../../mail/mail.service';

const STATE_KEY = 'live:circuit-breaker';
const ROLLING_DAYS = 60;

export interface BreakerState {
  tripped: boolean;
  trippedAt: string | null;
  rollingPnl: number;
  threshold: number;
}

@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name);
  private cached: BreakerState | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
  ) {}

  private get enabled(): boolean {
    return (this.config.get<string>('CIRCUIT_BREAKER') || 'true').toLowerCase() === 'true';
  }

  private get lossPct(): number {
    const v = parseFloat(this.config.get<string>('CIRCUIT_BREAKER_LOSS_PCT') || '15');
    return isNaN(v) || v <= 0 ? 15 : v;
  }

  /** Fast gate for the execution path — cached state, no DB hit per signal. */
  async isTripped(): Promise<boolean> {
    if (!this.enabled) return false;
    if (this.cached) return this.cached.tripped;
    const raw = await this.redis.get(STATE_KEY);
    this.cached = raw ? (JSON.parse(raw) as BreakerState) : null;
    return this.cached?.tripped ?? false;
  }

  async getState(): Promise<BreakerState & { enabled: boolean }> {
    const raw = await this.redis.get(STATE_KEY);
    const st = raw
      ? (JSON.parse(raw) as BreakerState)
      : { tripped: false, trippedAt: null, rollingPnl: 0, threshold: 0 };
    return { ...st, enabled: this.enabled };
  }

  /** Manual admin reset — the human decision to resume trading. */
  async reset(): Promise<void> {
    await this.redis.del(STATE_KEY);
    this.cached = null;
    this.logger.warn('Circuit breaker RESET by admin — new entries resume');
  }

  @Cron('20 */15 * * * *') // every 15 min, offset from other crons
  async check(): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.checkOnce();
    } catch (err) {
      this.logger.warn(`breaker check failed: ${(err as Error).message}`);
    }
  }

  async checkOnce(): Promise<BreakerState> {
    const since = new Date(Date.now() - ROLLING_DAYS * 24 * 3600 * 1000);
    const agg = await this.prisma.trade.aggregate({
      _sum: { pnl: true },
      where: {
        status: 'CLOSED',
        pnl: { not: null },
        closedAt: { gte: since },
        OR: [{ exitReason: null }, { exitReason: { notIn: ['ORPHAN', 'STALE_BROKER'] } }],
      },
    });
    const rollingPnl = agg._sum.pnl ?? 0;

    // Equity basis: newest snapshot per enabled account, summed.
    const snaps = await this.prisma.equitySnapshot.findMany({
      where: { account: { isEnabled: true } },
      orderBy: { takenAt: 'desc' },
      distinct: ['accountId'],
      select: { equity: true },
    });
    const equity = snaps.reduce((s, r) => s + r.equity, 0) || 1000;
    const threshold = -(this.lossPct / 100) * equity;

    const prev = await this.getState();
    const state: BreakerState = {
      tripped: prev.tripped || rollingPnl <= threshold,
      trippedAt: prev.tripped ? prev.trippedAt : rollingPnl <= threshold ? new Date().toISOString() : null,
      rollingPnl: Math.round(rollingPnl * 100) / 100,
      threshold: Math.round(threshold * 100) / 100,
    };
    await this.redis.set(STATE_KEY, JSON.stringify(state));
    this.cached = state;

    if (state.tripped && !prev.tripped) {
      this.logger.error(
        `CIRCUIT BREAKER TRIPPED: rolling ${ROLLING_DAYS}d realized PnL ${state.rollingPnl} <= ${state.threshold}. New entries PAUSED.`,
      );
      const admins = await this.prisma.user.findMany({
        where: { role: 'SUPERADMIN', isActive: true },
        select: { email: true },
      });
      for (const a of admins) {
        await this.mail.sendAlert(
          a.email,
          '🛑 ShamarX circuit breaker tripped — trading paused',
          `Rolling ${ROLLING_DAYS}-day realized PnL hit ${state.rollingPnl} (threshold ${state.threshold}, ` +
            `equity basis ${Math.round(equity)}).\n\nNew entries are PAUSED. Open positions continue to be ` +
            `managed to their natural exits.\n\nReview the market regime and, when ready, resume via ` +
            `ADMIN → Live → Resume Trading (or POST /api/strategy/live/circuit-breaker/reset).`,
        );
      }
    }
    return state;
  }
}
