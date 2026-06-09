import { Injectable } from '@nestjs/common';
import { PrismaService } from '@app/prisma';
import { STRATEGY_BASELINE } from './baseline';
import { Flag, Trend, StrategyStatus } from './types';
import { LiveAnalyticsService } from '../../strategy/live/live-analytics.service';

const DD_ALERT_PCT = 5;
const PAUSE_WATCH_DAYS = 7;
const INACTIVE_DAYS = 14;
const WR_DRIFT_PP = 5;
const EXPECTANCY_DRIFT_R = 0.1;

@Injectable()
export class AdminAnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LiveAnalyticsService,
  ) {}

  async aggregate() {
    const totalUsers = await this.prisma.user.count();
    const activeUsers = await this.prisma.user.count({ where: { botEnabled: true, isActive: true } });
    const totalAccounts = await this.prisma.brokerAccount.count();
    const enabledAccounts = await this.prisma.brokerAccount.count({ where: { isEnabled: true } });
    const latestSnapshots = await this.prisma.equitySnapshot.findMany({
      orderBy: { takenAt: 'desc' },
      distinct: ['accountId'],
      take: 1000,
      select: { equity: true },
    });
    const totalEquity = latestSnapshots.reduce((s, x) => s + x.equity, 0);
    const tradesToday = await this.prisma.trade.count({
      where: { createdAt: { gte: new Date(Date.now() - 86_400_000) } },
    });
    return { totalUsers, activeUsers, totalAccounts, enabledAccounts, totalEquity, dayDelta: 0, tradesToday };
  }

  async listUsers() {
    const users = await this.prisma.user.findMany({
      orderBy: { email: 'asc' },
      include: { brokerAccounts: { select: { id: true, isEnabled: true } } },
    });
    return Promise.all(
      users.map(async (u) => {
        const snap = await this.live.snapshot(u.id);
        const lastTrade = await this.prisma.trade.findFirst({
          where: { account: { userId: u.id } },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        });
        const enabledCount = u.brokerAccounts.filter((a) => a.isEnabled).length;
        return {
          id: u.id,
          email: u.email,
          presetKey: u.presetKey,
          equity: snap.equity,
          mtdPct: snap.mtdPct,
          winRate: snap.winRate,
          maxDd: snap.maxDd,
          lastTradeAt: lastTrade?.createdAt ?? null,
          status: !u.isActive ? 'disabled' : !u.botEnabled ? 'paused' : enabledCount === 0 ? 'no-accounts' : 'live',
          botEnabled: u.botEnabled,
          isActive: u.isActive,
          pausedAt: u.pausedAt,
        };
      }),
    );
  }

  async computeFlags(): Promise<Flag[]> {
    const flags: Flag[] = [];
    const users = await this.prisma.user.findMany({ include: { brokerAccounts: true } });
    const now = Date.now();

    for (const u of users) {
      if (!u.botEnabled && u.pausedAt) {
        const daysPaused = (now - u.pausedAt.getTime()) / 86_400_000;
        if (daysPaused > PAUSE_WATCH_DAYS) {
          flags.push({
            name: 'PAUSE_WATCH', severity: 'signal', userId: u.id, userEmail: u.email,
            message: `${u.email} — paused ${Math.floor(daysPaused)} days`,
            detail: 'consider checking in',
          });
        }
      }

      const enabledCount = u.brokerAccounts.filter((a) => a.isEnabled).length;
      if (u.lastLoginAt && enabledCount > 0) {
        const daysSinceLogin = (now - u.lastLoginAt.getTime()) / 86_400_000;
        if (daysSinceLogin > INACTIVE_DAYS) {
          flags.push({
            name: 'INACTIVE_USER', severity: 'signal', userId: u.id, userEmail: u.email,
            message: `${u.email} — inactive ${Math.floor(daysSinceLogin)} days`,
            detail: `${enabledCount} enabled account(s) still trading`,
          });
        }
      }

      if (u.botEnabled && enabledCount === 0) {
        flags.push({
          name: 'NO_ACCOUNTS', severity: 'neutral', userId: u.id, userEmail: u.email,
          message: `${u.email} — bot enabled but no enabled accounts`,
        });
      }

      const snap = await this.live.snapshot(u.id);
      if (snap.maxDd > DD_ALERT_PCT) {
        flags.push({
          name: 'DD_ALERT', severity: 'loss', userId: u.id, userEmail: u.email,
          message: `${u.email} — ${snap.maxDd.toFixed(1)}% drawdown`,
          detail: `threshold: ${DD_ALERT_PCT}%`,
        });
      }
    }

    const sevOrder: Record<string, number> = { loss: 0, signal: 1, neutral: 2 };
    return flags.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);
  }

  async computeTrends(): Promise<{ trends: Trend[]; wrDriftPp: number; expectancyDriftR: number; sampleSize: number }> {
    const since = new Date(Date.now() - 30 * 86_400_000);
    const recentTrades = await this.prisma.trade.findMany({
      where: { status: 'CLOSED', closedAt: { gte: since } },
      select: { pnl: true, symbol: true, entryPrice: true, slPrice: true, lotSize: true, side: true },
    });
    const sampleSize = recentTrades.length;
    const wins = recentTrades.filter((t) => (t.pnl ?? 0) > 0).length;
    const wr = sampleSize > 0 ? wins / sampleSize : STRATEGY_BASELINE.winRate;

    // Implied R per trade: pnl / risk where risk = |entry-slPrice| * lotSize (mirrors live-analytics compute())
    const totalR = recentTrades.reduce((sum, t) => {
      const risk = Math.abs((t.entryPrice ?? 0) - (t.slPrice ?? 0)) * (t.lotSize ?? 0);
      const r = risk > 0 ? (t.pnl ?? 0) / risk : 0;
      return sum + r;
    }, 0);
    const expectancy = sampleSize > 0 ? totalR / sampleSize : STRATEGY_BASELINE.expectancy;

    const wrDriftPp = (wr - STRATEGY_BASELINE.winRate) * 100;
    const expectancyDriftR = expectancy - STRATEGY_BASELINE.expectancy;

    const trends: Trend[] = [];
    if (sampleSize >= 10 && Math.abs(wrDriftPp) > WR_DRIFT_PP) {
      trends.push({
        name: 'WR_DRIFT', direction: wrDriftPp >= 0 ? 'up' : 'down',
        magnitude: Math.abs(wrDriftPp), sampleSize,
        recommendation: `Win rate is ${Math.abs(wrDriftPp).toFixed(1)}pp ${wrDriftPp >= 0 ? 'above' : 'below'} baseline on ${sampleSize} trades. Re-run validation backtest for current period.`,
      });
    }
    if (sampleSize >= 10 && Math.abs(expectancyDriftR) > EXPECTANCY_DRIFT_R) {
      trends.push({
        name: 'EXPECTANCY_DRIFT', direction: expectancyDriftR >= 0 ? 'up' : 'down',
        magnitude: Math.abs(expectancyDriftR), sampleSize,
        recommendation: `Expectancy is ${expectancyDriftR.toFixed(2)}R ${expectancyDriftR >= 0 ? 'above' : 'below'} baseline.`,
      });
    }

    return { trends, wrDriftPp, expectancyDriftR, sampleSize };
  }

  computeStatus(
    flags: Flag[],
    trendStats: { wrDriftPp: number; expectancyDriftR: number; sampleSize: number },
  ): StrategyStatus {
    const lossFlags = flags.filter((f) => f.severity === 'loss').length;
    const absWrDrift = Math.abs(trendStats.wrDriftPp);
    const absExpectancyDrift = Math.abs(trendStats.expectancyDriftR);

    if (lossFlags >= 2 || absWrDrift > 5 || (absExpectancyDrift > 0.15 && trendStats.sampleSize >= 30)) {
      return 'DEGRADED';
    }
    if (lossFlags >= 1 || absWrDrift > 3) {
      return 'WATCHING';
    }
    return 'HEALTHY';
  }
}
