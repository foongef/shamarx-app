import { LiveStrategyService } from './live-strategy.service';

/**
 * Helper: builds a fake BrokerAccountWithUser with sensible defaults.
 * Only the fields that evaluatePairForAccount gate logic touches are
 * required; everything else is typed as `any` so we don't have to
 * stub every Prisma column.
 */
function makeAccount(overrides: Partial<{
  botEnabled: boolean;
  isActive: boolean;
  presetKey: 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE';
  isEnabled: boolean;
}> = {}) {
  return {
    id: 'acct-1',
    isEnabled: overrides.isEnabled ?? true,
    user: {
      id: 'user-1',
      botEnabled: overrides.botEnabled ?? true,
      isActive: overrides.isActive ?? true,
      presetKey: overrides.presetKey ?? 'BALANCED',
    },
  } as any;
}

describe('LiveStrategyService — per-user gates', () => {
  let service: LiveStrategyService;

  beforeEach(() => {
    // Construct the service with all deps stubbed. We only exercise the
    // public gate method; evaluatePairForAccountInternal is spied on.
    service = new LiveStrategyService(
      {} as any, // PrismaService
      {} as any, // RedisService
      {} as any, // HttpService
      {
        get: (key: string) => {
          if (key === 'LIVE_MODE') return 'false';
          if (key === 'STRATEGY_PAIRS') return 'XAUUSD,EURUSD,GBPUSD,USDJPY';
          if (key === 'ENABLE_MULTI_ACCOUNT_FANOUT') return 'false';
          return undefined;
        },
      } as any, // ConfigService
      { getRiskPercent: () => 1.0, isRunning: () => false } as any, // LiveControlService
      {} as any, // LiveSmcOrchestrator
      {} as any, // MailService
      {} as any, // JournalService
      {} as any, // BrokerAccountsService
      {} as any, // BrokerHttpClient
      {} as any, // LiveSmcOrchestratorRegistry
    );
  });

  it('skips fan-out when user.botEnabled = false', async () => {
    const acct = makeAccount({ botEnabled: false });
    const internalSpy = jest.spyOn(service as any, 'evaluatePairForAccountInternal');
    await service.evaluatePairForAccount('EURUSD', acct);
    expect(internalSpy).not.toHaveBeenCalled();
  });

  it('skips fan-out when user.isActive = false', async () => {
    const acct = makeAccount({ isActive: false });
    const internalSpy = jest.spyOn(service as any, 'evaluatePairForAccountInternal');
    await service.evaluatePairForAccount('EURUSD', acct);
    expect(internalSpy).not.toHaveBeenCalled();
  });

  it('skips when symbol not in user preset pairs (CONSERVATIVE excludes XAUUSD)', async () => {
    const acct = makeAccount({ presetKey: 'CONSERVATIVE' });
    const internalSpy = jest.spyOn(service as any, 'evaluatePairForAccountInternal');
    await service.evaluatePairForAccount('XAUUSD', acct);
    expect(internalSpy).not.toHaveBeenCalled();
  });

  it('proceeds when all gates pass and threads preset params', async () => {
    const acct = makeAccount({});
    const internalSpy = jest
      .spyOn(service as any, 'evaluatePairForAccountInternal')
      .mockResolvedValue(null);
    await service.evaluatePairForAccount('EURUSD', acct);
    expect(internalSpy).toHaveBeenCalledWith(
      'EURUSD',
      acct,
      expect.objectContaining({ riskPercent: 1.0 }),
    );
  });
});

describe('LiveStrategyService.fetchCandles — unified candle source (live-vs-replay divergence fix)', () => {
  const { LiveStrategyService } = require('./live-strategy.service');

  function makeService(opts: {
    dbRows: Array<{ openTime: Date }>;
    httpRows?: Array<{ openTime: string }>;
  }) {
    const svc: any = Object.create(LiveStrategyService.prototype);
    svc.logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn(), debug: jest.fn() };
    svc.prisma = {
      candle: {
        findMany: jest.fn(async () =>
          opts.dbRows.map((r) => ({
            symbol: 'EURUSD', timeframe: 'M15', openTime: r.openTime,
            open: 1.1, high: 1.2, low: 1.0, close: 1.15, volume: 100,
          })),
        ),
      },
    };
    const httpGet = jest.fn(() => ({
      subscribe: undefined,
      // firstValueFrom needs an Observable; emulate with of()
    }));
    const { of } = require('rxjs');
    svc.httpService = {
      get: jest.fn(() =>
        of({
          data: (opts.httpRows ?? []).map((r) => ({
            symbol: 'EURUSD', timeframe: 'M15', openTime: r.openTime,
            open: 9.9, high: 9.9, low: 9.9, close: 9.9, volume: 1,
          })),
        }),
      ),
    };
    return svc;
  }

  it('returns DB rows and never calls the broker when the table is fresh', async () => {
    const justClosed = new Date(Date.now() - 16 * 60_000); // M15 closed 1 min ago
    const svc = makeService({ dbRows: [justClosed].map((d) => ({ openTime: d })) });
    const out = await svc.fetchCandles('EURUSD', 'M15', 100);
    expect(out).toHaveLength(1);
    expect(out[0].close).toBe(1.15); // DB value, not the 9.9 HTTP sentinel
    expect(svc.httpService.get).not.toHaveBeenCalled();
  });

  it('falls back to the broker fetch and logs an error when the table is stale', async () => {
    const stale = new Date(Date.now() - 3 * 60 * 60_000); // 3h old M15
    const closedHttpBar = new Date(Date.now() - 20 * 60_000).toISOString();
    const svc = makeService({
      dbRows: [{ openTime: stale }],
      httpRows: [{ openTime: closedHttpBar }],
    });
    const out = await svc.fetchCandles('EURUSD', 'M15', 100);
    expect(svc.logger.error).toHaveBeenCalledWith(expect.stringContaining('stale'));
    expect(svc.httpService.get).toHaveBeenCalled();
    expect(out[0].close).toBe(9.9); // came from fallback
  });

  it('fallback drops the in-progress bar from the broker response', async () => {
    const stale = new Date(Date.now() - 3 * 60 * 60_000);
    const closedBar = new Date(Date.now() - 20 * 60_000).toISOString();
    const openBar = new Date(Date.now() - 5 * 60_000).toISOString(); // still forming
    const svc = makeService({
      dbRows: [{ openTime: stale }],
      httpRows: [{ openTime: closedBar }, { openTime: openBar }],
    });
    const out = await svc.fetchCandles('EURUSD', 'M15', 100);
    expect(out).toHaveLength(1);
    expect(out[0].openTime).toBe(closedBar);
  });

  it('D1 always reads the DB — no staleness fallback (resample lags by design)', async () => {
    const threeDaysOld = new Date(Date.now() - 3 * 24 * 60 * 60_000);
    const svc = makeService({ dbRows: [{ openTime: threeDaysOld }] });
    svc.prisma.candle.findMany = jest.fn(async () => [{
      symbol: 'EURUSD', timeframe: 'D1', openTime: threeDaysOld,
      open: 1.1, high: 1.2, low: 1.0, close: 1.15, volume: 100,
    }]);
    const out = await svc.fetchCandles('EURUSD', 'D1', 400);
    expect(out).toHaveLength(1);
    expect(svc.httpService.get).not.toHaveBeenCalled();
    expect(svc.logger.error).not.toHaveBeenCalled();
  });
});
