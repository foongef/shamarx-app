/**
 * Tenancy regression tests — a USER-role token must NEVER receive the
 * platform-default (house) account's money data or other tenants' account
 * lists. Guards the fix for the cross-tenant leak where a fresh user with
 * zero accounts saw the owner's equity on /lives.
 */
import { of } from 'rxjs';
import { StrategyController } from './strategy.controller';
import { AuthenticatedUser } from '../auth/auth.service';

const FRIEND: AuthenticatedUser = { id: 'user-2', email: 'friend@x.com', role: 'USER' };
const OWNER: AuthenticatedUser = { id: 'user-1', email: 'owner@x.com', role: 'SUPERADMIN' };

function makeController() {
  const control = {
    status: () => ({ enabled: true, running: true, mt5Mode: 'metaapi', pairs: ['EURUSD'], riskPercent: 1.5, lastChangedAt: null }),
    isRunning: () => true,
    getConfig: () => ({ mode: 'metaapi' }),
  };
  const httpService = {
    get: jest.fn(() => of({ data: { balance: 1037.64, equity: 1044.86, margin: 0, freeMargin: 1044.86, openPositions: 0 } })),
  };
  const prisma = {
    equitySnapshot: { findFirst: jest.fn().mockResolvedValue(null) },
    brokerAccount: { findMany: jest.fn().mockResolvedValue([]) },
    candle: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
  };
  const redis = { get: jest.fn().mockResolvedValue(null) };
  const controller = new StrategyController(
    {} as any, // LiveStrategyService
    {} as any, // PositionMonitorService
    control as any,
    {} as any, // LiveAnalyticsService
    httpService as any,
    prisma as any,
    redis as any,
    {} as any, // BrokerHttpClient,
      { getState: async () => ({ tripped: false }), reset: async () => {} } as any,
    );
  return { controller, httpService, prisma };
}

describe('StrategyController tenancy', () => {
  it('live/status: USER never receives house account or stale equity', async () => {
    const { controller, httpService, prisma } = makeController();
    const res = await controller.status(FRIEND);
    expect(res.account).toBeNull();
    expect(res.accountStale).toBeNull();
    // Engine state stays visible — the engine is shared.
    expect(res.running).toBe(true);
    // And no house-account lookups even happen on the user path.
    expect(httpService.get).not.toHaveBeenCalled();
    expect(prisma.equitySnapshot.findFirst).not.toHaveBeenCalled();
  });

  it('live/status: SUPERADMIN still gets the house account', async () => {
    const { controller } = makeController();
    const res = await controller.status(OWNER);
    expect(res.account).toMatchObject({ equity: 1044.86 });
  });

  it('live/positions: USER gets an empty list, no broker call', async () => {
    const { controller, httpService } = makeController();
    const res = await controller.openPositions(FRIEND);
    expect(res).toEqual({ positions: [] });
    expect(httpService.get).not.toHaveBeenCalled();
  });

  it('live/loop-health: USER account list is scoped to their userId', async () => {
    const { controller, prisma } = makeController();
    await controller.loopHealth(FRIEND);
    expect(prisma.brokerAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isEnabled: true, userId: FRIEND.id }),
      }),
    );
  });

  it('live/loop-health: SUPERADMIN sees the whole fleet (no userId filter)', async () => {
    const { controller, prisma } = makeController();
    await controller.loopHealth(OWNER);
    const where = prisma.brokerAccount.findMany.mock.calls[0][0].where;
    expect(where.userId).toBeUndefined();
  });
});
