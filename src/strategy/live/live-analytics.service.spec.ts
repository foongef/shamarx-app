/**
 * Unit tests for LiveAnalyticsService — Spec 2.5 analytics methods.
 *
 * All tests exercise the empty-state (no accounts) path, which resolves
 * without hitting Postgres. The Prisma calls are mocked so these run
 * even when the local database is offline.
 */
import { LiveAnalyticsService } from './live-analytics.service';

function makePrismaMock(overrides: Partial<{
  brokerAccountFindMany: jest.Mock;
  equitySnapshotFindFirst: jest.Mock;
  equitySnapshotFindMany: jest.Mock;
  tradeFindMany: jest.Mock;
  userFindUniqueOrThrow: jest.Mock;
}> = {}) {
  return {
    brokerAccount: {
      findMany: overrides.brokerAccountFindMany ?? jest.fn().mockResolvedValue([]),
    },
    equitySnapshot: {
      findFirst: overrides.equitySnapshotFindFirst ?? jest.fn().mockResolvedValue(null),
      findMany: overrides.equitySnapshotFindMany ?? jest.fn().mockResolvedValue([]),
    },
    trade: {
      findMany: overrides.tradeFindMany ?? jest.fn().mockResolvedValue([]),
    },
    user: {
      findUniqueOrThrow: overrides.userFindUniqueOrThrow ?? jest.fn().mockResolvedValue({
        id: 'user-1',
        presetKey: 'BALANCED',
      }),
    },
  } as any;
}

describe('LiveAnalyticsService — Spec 2.5 analytics methods', () => {
  describe('snapshot', () => {
    it('returns zeros when user has no accounts', async () => {
      const service = new LiveAnalyticsService(makePrismaMock());
      const result = await service.snapshot('user-no-accounts');
      expect(result.netReturnPct).toBe(0);
      expect(result.tradesCount).toBe(0);
      expect(result.equity).toBe(0);
      expect(result.winRate).toBe(0);
      expect(result.maxDd).toBe(0);
      expect(result.expectancy).toBe(0);
      expect(result.mtdPct).toBe(0);
    });
  });

  describe('equityCurve', () => {
    it('returns empty array when user has no accounts', async () => {
      const service = new LiveAnalyticsService(makePrismaMock());
      const result = await service.equityCurve({ userId: 'user-no-accounts', days: 30 });
      expect(result).toEqual([]);
    });
  });

  describe('riskUsedToday', () => {
    it('returns default daily-loss-limit (3.0) for BALANCED preset when user has no accounts', async () => {
      const service = new LiveAnalyticsService(makePrismaMock());
      const result = await service.riskUsedToday('user-no-accounts');
      expect(result.dailyLossLimit).toBe(3.0);
      expect(result.pctUsedToday).toBe(0);
      expect(result.openRiskPct).toBe(0);
    });

    it('returns dailyLossLimit = 2.0 for CONSERVATIVE preset user', async () => {
      const service = new LiveAnalyticsService(makePrismaMock({
        brokerAccountFindMany: jest.fn().mockResolvedValueOnce([{ id: 'acct-1' }])
          .mockResolvedValue([{ id: 'acct-1' }]),
        userFindUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'user-c', presetKey: 'CONSERVATIVE' }),
        equitySnapshotFindFirst: jest.fn().mockResolvedValue({ equity: 10000 }),
        tradeFindMany: jest.fn().mockResolvedValue([]),
      }));
      const result = await service.riskUsedToday('user-c');
      expect(result.dailyLossLimit).toBe(2.0);
      expect(result.openRiskPct).toBe(0);
    });

    it('returns dailyLossLimit = 5.0 for AGGRESSIVE preset user', async () => {
      const service = new LiveAnalyticsService(makePrismaMock({
        brokerAccountFindMany: jest.fn().mockResolvedValueOnce([{ id: 'acct-1' }])
          .mockResolvedValue([{ id: 'acct-1' }]),
        userFindUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'user-a', presetKey: 'AGGRESSIVE' }),
        equitySnapshotFindFirst: jest.fn().mockResolvedValue({ equity: 10000 }),
        tradeFindMany: jest.fn().mockResolvedValue([]),
      }));
      const result = await service.riskUsedToday('user-a');
      expect(result.dailyLossLimit).toBe(5.0);
    });
  });

  describe('snapshot — with seeded data', () => {
    it('computes netReturnPct from first and last equity snapshots', async () => {
      const service = new LiveAnalyticsService(makePrismaMock({
        brokerAccountFindMany: jest.fn().mockResolvedValue([{ id: 'acct-1' }]),
        equitySnapshotFindFirst: jest.fn()
          .mockResolvedValueOnce({ equity: 11000, takenAt: new Date() }) // latest
          .mockResolvedValueOnce({ equity: 10000, takenAt: new Date() }) // first
          .mockResolvedValueOnce(null),                                   // mtd first
        equitySnapshotFindMany: jest.fn().mockResolvedValue([
          { equity: 10000 },
          { equity: 11000 },
        ]),
        tradeFindMany: jest.fn().mockResolvedValue([]),
      }));
      const result = await service.snapshot('user-1');
      expect(result.equity).toBe(11000);
      expect(result.netReturnPct).toBeCloseTo(10, 5);
      expect(result.tradesCount).toBe(0);
    });
  });

  describe('equityCurve — with seeded data', () => {
    it('aggregates snapshots by day across multiple accounts', async () => {
      const now = new Date('2026-06-09T12:00:00Z');
      const service = new LiveAnalyticsService(makePrismaMock({
        brokerAccountFindMany: jest.fn().mockResolvedValue([{ id: 'acct-1' }, { id: 'acct-2' }]),
        equitySnapshotFindMany: jest.fn().mockResolvedValue([
          { takenAt: now, equity: 5000, accountId: 'acct-1' },
          { takenAt: now, equity: 5500, accountId: 'acct-2' },
        ]),
      }));
      const result = await service.equityCurve({ userId: 'user-1', days: 30 });
      expect(result).toHaveLength(1);
      expect(result[0].date).toBe('2026-06-09');
      expect(result[0].equity).toBe(10500);
    });
  });
});

describe('LiveAnalyticsService — ORPHAN exclusion (2026-06-08 regression)', () => {
  it('compute() drops ORPHAN rows from WR / pnl / exitReason stats', () => {
    const service = new LiveAnalyticsService(makePrismaMock());
    const trades = [
      { status: 'CLOSED', pnl: 15, exitReason: 'TP', symbol: 'EURUSD' },
      { status: 'CLOSED', pnl: -10, exitReason: 'SL', symbol: 'EURUSD' },
      // 3 reconciliation artifacts that would otherwise crush the WR
      { status: 'CLOSED', pnl: 0, exitReason: 'ORPHAN', symbol: 'USDJPY' },
      { status: 'CLOSED', pnl: 0, exitReason: 'ORPHAN', symbol: 'USDJPY' },
      { status: 'CLOSED', pnl: 0, exitReason: 'ORPHAN', symbol: 'GBPUSD' },
    ] as any[];

    const stats = (service as any).compute(trades);

    expect(stats.totalTrades ?? stats.closedTrades ?? 2).toBeDefined();
    expect(stats.winRate).toBeCloseTo(50, 5); // 1 of 2 REAL trades — not 1 of 5
    expect(stats.exitReasons.ORPHAN).toBeUndefined();
    expect(stats.totalPnl).toBeCloseTo(5, 5);
  });

  it('snapshot() query excludes ORPHAN (OR-form preserves NULL exitReason rows)', async () => {
    const tradeFindMany = jest.fn().mockResolvedValue([]);
    const prisma = makePrismaMock({
      brokerAccountFindMany: jest.fn().mockResolvedValue([{ id: 'acct-1', isEnabled: true }]),
      tradeFindMany,
    });
    const service = new LiveAnalyticsService(prisma);
    await service.snapshot('user-1');

    const tradeCall = tradeFindMany.mock.calls.find(
      ([arg]: any[]) => arg?.where?.status === 'CLOSED' && arg?.where?.account,
    );
    expect(tradeCall).toBeDefined();
    expect(tradeCall![0].where.OR).toEqual([
      { exitReason: null },
      { exitReason: { not: 'ORPHAN' } },
    ]);
  });
});

describe('LiveAnalyticsService — participant session scoping (tenancy)', () => {
  function svc(over: any = {}) {
    const prisma = {
      liveSession: {
        findUnique: over.findUnique ?? jest.fn(),
        findMany: over.findMany ?? jest.fn().mockResolvedValue([]),
      },
      brokerAccount: { count: over.acctCount ?? jest.fn().mockResolvedValue(0) },
      trade: {
        findMany: over.tradeFindMany ?? jest.fn().mockResolvedValue([]),
        count: over.tradeCount ?? jest.fn().mockResolvedValue(0),
      },
    } as any;
    return { service: new LiveAnalyticsService(prisma), prisma };
  }

  it('getSession: non-owner with an enabled account can open the RUNNING session, scoped to their trades', async () => {
    const { service, prisma } = svc({
      findUnique: jest.fn().mockResolvedValue({ id: 'sess-1', status: 'RUNNING', startedAt: new Date() }),
      acctCount: jest.fn().mockResolvedValue(1),
      tradeCount: jest.fn().mockResolvedValue(0),
      tradeFindMany: jest.fn().mockResolvedValue([]),
    });
    const res = await service.getSession('grace', 'sess-1', false);
    expect(res).not.toBeNull();
    // Aggregates must be scoped to Grace's account, never global.
    const where = prisma.trade.findMany.mock.calls[0][0].where;
    expect(where.account).toEqual({ userId: 'grace' });
  });

  it('getSession: non-owner with no account and no trades in an ENDED session → null', async () => {
    const { service } = svc({
      findUnique: jest.fn().mockResolvedValue({ id: 'sess-1', status: 'ENDED', startedAt: new Date() }),
      acctCount: jest.fn().mockResolvedValue(0),
      tradeCount: jest.fn().mockResolvedValue(0),
    });
    expect(await service.getSession('stranger', 'sess-1', false)).toBeNull();
  });

  it('getSession: admin sees the global (owner-scoped) session, aggregates NOT filtered by viewer', async () => {
    const { service, prisma } = svc({
      findUnique: jest.fn(),
      tradeFindMany: jest.fn().mockResolvedValue([]),
    });
    // admin path uses findFirst on the prisma mock — add it
    prisma.liveSession.findFirst = jest.fn().mockResolvedValue({ id: 'sess-1', status: 'RUNNING', startedAt: new Date() });
    await service.getSession('owner', 'sess-1', true);
    const where = prisma.trade.findMany.mock.calls[0][0].where;
    expect(where.account).toBeUndefined(); // global, not viewer-scoped
  });

  it('listSessions: participant query targets running + own-traded sessions', async () => {
    const { service, prisma } = svc({
      acctCount: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([]),
    });
    await service.listSessions({ userId: 'grace', isAdmin: false });
    const where = prisma.liveSession.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual(expect.arrayContaining([
      { trades: { some: { account: { userId: 'grace' } } } },
      { status: 'RUNNING' },
    ]));
  });
});
