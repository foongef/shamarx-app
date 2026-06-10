import { Test } from '@nestjs/testing';
import { AdminAnalyticsService } from './admin-analytics.service';
import { PrismaService } from '@app/prisma';
import { LiveAnalyticsService } from '../../strategy/live/live-analytics.service';

describe('AdminAnalyticsService', () => {
  let svc: AdminAnalyticsService;
  let prismaMock: any;
  let liveMock: any;

  beforeEach(async () => {
    prismaMock = {
      user: { count: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
      brokerAccount: { count: jest.fn() },
      equitySnapshot: { findMany: jest.fn().mockResolvedValue([]) },
      trade: { count: jest.fn(), findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn() },
    };
    liveMock = { snapshot: jest.fn().mockResolvedValue({ equity: 0, mtdPct: 0, winRate: 0, maxDd: 0, netReturnPct: 0, expectancy: 0, tradesCount: 0 }) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        AdminAnalyticsService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: LiveAnalyticsService, useValue: liveMock },
      ],
    }).compile();
    svc = moduleRef.get(AdminAnalyticsService);
  });

  describe('aggregate()', () => {
    it('returns counts + sum', async () => {
      prismaMock.user.count.mockResolvedValueOnce(4).mockResolvedValueOnce(3);
      prismaMock.brokerAccount.count.mockResolvedValueOnce(7).mockResolvedValueOnce(6);
      prismaMock.equitySnapshot.findMany.mockResolvedValueOnce([{ equity: 10000 }, { equity: 5000 }]);
      prismaMock.trade.count.mockResolvedValueOnce(14);
      const r = await svc.aggregate();
      expect(r.totalUsers).toBe(4);
      expect(r.activeUsers).toBe(3);
      expect(r.totalAccounts).toBe(7);
      expect(r.enabledAccounts).toBe(6);
      expect(r.totalEquity).toBe(15000);
      expect(r.tradesToday).toBe(14);
    });
  });

  describe('computeFlags()', () => {
    it('emits PAUSE_WATCH for users paused > 7 days ago', async () => {
      const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000);
      prismaMock.user.findMany.mockResolvedValue([
        { id: 'u1', email: 'a@x', botEnabled: false, pausedAt: eightDaysAgo, lastLoginAt: null, brokerAccounts: [] },
      ]);
      const flags = await svc.computeFlags();
      expect(flags.some((f) => f.name === 'PAUSE_WATCH')).toBe(true);
    });

    it('does NOT emit PAUSE_WATCH for recent pauses', async () => {
      prismaMock.user.findMany.mockResolvedValue([
        { id: 'u1', email: 'a@x', botEnabled: false, pausedAt: new Date(), lastLoginAt: null, brokerAccounts: [] },
      ]);
      const flags = await svc.computeFlags();
      expect(flags.some((f) => f.name === 'PAUSE_WATCH')).toBe(false);
    });

    it('emits INACTIVE_USER for old login + enabled accounts', async () => {
      prismaMock.user.findMany.mockResolvedValue([
        { id: 'u1', email: 'a@x', botEnabled: true, pausedAt: null, lastLoginAt: new Date(Date.now() - 20 * 86_400_000), brokerAccounts: [{ id: 'a1', isEnabled: true }] },
      ]);
      const flags = await svc.computeFlags();
      expect(flags.some((f) => f.name === 'INACTIVE_USER')).toBe(true);
    });

    it('emits NO_ACCOUNTS when botEnabled and 0 enabled accounts', async () => {
      prismaMock.user.findMany.mockResolvedValue([
        { id: 'u1', email: 'a@x', botEnabled: true, pausedAt: null, lastLoginAt: null, brokerAccounts: [] },
      ]);
      const flags = await svc.computeFlags();
      expect(flags.some((f) => f.name === 'NO_ACCOUNTS')).toBe(true);
    });

    it('emits DD_ALERT when snapshot.maxDd > 5%', async () => {
      prismaMock.user.findMany.mockResolvedValue([
        { id: 'u1', email: 'a@x', botEnabled: true, pausedAt: null, lastLoginAt: null, brokerAccounts: [{ id: 'a1', isEnabled: true }] },
      ]);
      liveMock.snapshot.mockResolvedValueOnce({ maxDd: 6.5, equity: 0, mtdPct: 0, winRate: 0, netReturnPct: 0, expectancy: 0, tradesCount: 0 });
      const flags = await svc.computeFlags();
      expect(flags.some((f) => f.name === 'DD_ALERT')).toBe(true);
    });

    it('sorts loss > signal > neutral', async () => {
      prismaMock.user.findMany.mockResolvedValue([
        { id: 'u1', email: 'a@x', botEnabled: true, pausedAt: null, lastLoginAt: null, brokerAccounts: [] }, // -> NO_ACCOUNTS (neutral)
        { id: 'u2', email: 'b@x', botEnabled: true, pausedAt: null, lastLoginAt: null, brokerAccounts: [{ id: 'a1', isEnabled: true }] }, // -> DD_ALERT (loss)
      ]);
      liveMock.snapshot.mockResolvedValueOnce({ maxDd: 0, equity: 0, mtdPct: 0, winRate: 0, netReturnPct: 0, expectancy: 0, tradesCount: 0 });
      liveMock.snapshot.mockResolvedValueOnce({ maxDd: 8, equity: 0, mtdPct: 0, winRate: 0, netReturnPct: 0, expectancy: 0, tradesCount: 0 });
      const flags = await svc.computeFlags();
      expect(flags[0].severity).toBe('loss');
    });
  });

  describe('computeStatus()', () => {
    it('returns HEALTHY with no flags and small WR drift', () => {
      expect(svc.computeStatus([], { wrDriftPp: 1, expectancyDriftR: 0.02, sampleSize: 50 })).toBe('HEALTHY');
    });
    it('returns WATCHING with 1 loss flag', () => {
      expect(svc.computeStatus([{ name: 'DD_ALERT', severity: 'loss', userId: 'u', userEmail: 'a', message: '' }], { wrDriftPp: 1, expectancyDriftR: 0.02, sampleSize: 50 })).toBe('WATCHING');
    });
    it('returns DEGRADED with 2+ loss flags', () => {
      expect(svc.computeStatus(
        [
          { name: 'DD_ALERT', severity: 'loss', userId: 'u', userEmail: 'a', message: '' },
          { name: 'BROKER_DOWN', severity: 'loss', userId: 'u2', userEmail: 'b', message: '' },
        ],
        { wrDriftPp: 1, expectancyDriftR: 0.02, sampleSize: 50 },
      )).toBe('DEGRADED');
    });
    it('returns DEGRADED with > 5pp WR drift', () => {
      expect(svc.computeStatus([], { wrDriftPp: 7, expectancyDriftR: 0, sampleSize: 50 })).toBe('DEGRADED');
    });
  });

  describe('computeTrends()', () => {
    it('returns empty trends when sample size < 10', async () => {
      prismaMock.trade.findMany.mockResolvedValue([]);
      const r = await svc.computeTrends();
      expect(r.trends).toEqual([]);
      expect(r.sampleSize).toBe(0);
    });

    it('excludes ORPHAN rows from the drift sample (2026-06-08 regression)', async () => {
      prismaMock.trade.findMany.mockResolvedValue([]);
      await svc.computeTrends();
      const where = prismaMock.trade.findMany.mock.calls[0][0].where;
      // The query must exclude reconciliation artifacts. OR-form because
      // Prisma's `not` silently drops NULL exitReason rows.
      expect(where.OR).toEqual([
        { exitReason: null },
        { exitReason: { not: 'ORPHAN' } },
      ]);
    });

    it('drift sample math is computed over the (already filtered) rows', async () => {
      // 10 real trades: 7 winners at +$15 / 3 losers at -$10, risk $10 each
      const real = Array.from({ length: 10 }, (_, i) => ({
        pnl: i < 7 ? 15 : -10,
        symbol: 'EURUSD',
        entryPrice: 1.085,
        slPrice: 1.084,   // slDistance 0.001 × lotSize 0.1 → risk used in R calc
        lotSize: 100,     // risk = 0.001 * 100 = 0.1 … keep simple: r = pnl / 0.1
        side: 'BUY',
      }));
      prismaMock.trade.findMany.mockResolvedValue(real);
      const r = await svc.computeTrends();
      expect(r.sampleSize).toBe(10);
      // WR = 70% vs 64.9% baseline → drift ≈ +5.1pp
      expect(r.wrDriftPp).toBeCloseTo((0.7 - 0.649) * 100, 1);
    });
  });
});
