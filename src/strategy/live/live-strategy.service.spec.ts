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
