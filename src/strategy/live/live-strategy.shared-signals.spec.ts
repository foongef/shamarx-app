/**
 * Shared-signal mode tests — ONE canonical signal per (symbol, bar); accounts
 * execute or skip, never diverge. Guards against the 2026-07-07 incident
 * where two accounts' independent orchestrators fired OPPOSITE trades on the
 * same bar.
 */
import { LiveStrategyService } from './live-strategy.service';
import { SmcLiveSignal } from './smc-live-evaluator';

const SIGNAL: SmcLiveSignal = {
  symbol: 'GBPUSD',
  side: 'SELL',
  entryPrice: 1.33794,
  slPrice: 1.33944,
  tpPrice: 1.33674,
  totalLot: 0.15, // sized against the 10k notional @ engine 1.5%
  legs: [
    { lotSize: 0.05, tpPrice: 1.33674, setupTags: ['TP1'] },
    { lotSize: 0.10, tpPrice: 1.3327, setupTags: ['RUNNER'] },
  ],
  mode: 'REVERSAL',
  h1SweepTime: '2026-07-07T12:00:00.000Z',
  reason: 'test',
};

function makeAccount(over: any = {}) {
  return {
    id: over.id ?? 'acct-1',
    name: over.name ?? 'Acct One',
    isEnabled: true,
    user: {
      id: over.userId ?? 'user-1',
      email: over.email ?? 'a@x.com',
      botEnabled: true,
      isActive: true,
      presetKey: over.presetKey ?? 'BALANCED', // 1.0% risk
      ...(over.user ?? {}),
    },
    ...over,
  } as any;
}

function makeService(over: any = {}) {
  // Prisma rows carry Date objects; keep the newest bar FRESH so
  // fetchCandles' staleness guard doesn't reroute to the broker fallback.
  const now = Date.now();
  const candles = Array.from({ length: 40 }, (_, i) => ({
    symbol: 'GBPUSD', timeframe: 'M15',
    openTime: new Date(now - (39 - i) * 15 * 60_000),
    open: 1.33, high: 1.34, low: 1.32, close: 1.335, volume: 100,
  }));
  const prisma = {
    trade: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      aggregate: jest.fn().mockResolvedValue({ _sum: { pnl: 0 } }),
    },
    // fresh copy per call — fetchCandles reverses rows IN PLACE
    candle: { findMany: jest.fn().mockImplementation(async () => [...candles].reverse()) },
  };
  const orchestrator = {
    evaluate: over.evaluate ?? jest.fn().mockReturnValue(SIGNAL),
    recordEntry: jest.fn(),
    getTelemetry: jest.fn().mockReturnValue({ GBPUSD: { pendingCount: 1, cooldownBarsRemaining: 0, pending: [] } }),
    serialize: jest.fn().mockReturnValue({}),
  };
  const brokerHttp = {
    fetchOpenPositions: over.fetchOpenPositions ?? jest.fn().mockResolvedValue([]),
    fetchAccount: over.fetchAccount ?? jest.fn().mockResolvedValue({ equity: 10000, balance: 10000 }),
  };
  const decisionLog = { record: jest.fn() };
  const config = {
    get: (k: string) => ({
      LIVE_MODE: 'false',
      STRATEGY_PAIRS: 'XAUUSD,EURUSD,GBPUSD,USDJPY',
      ENABLE_SHARED_SIGNALS: 'true',
      ENABLE_MULTI_ACCOUNT_FANOUT: 'true',
    } as Record<string, string>)[k],
  };
  const svc = new LiveStrategyService(
    prisma as any,
    { set: jest.fn(), subscribe: jest.fn(), publish: jest.fn() } as any, // Redis
    {} as any, // HttpService
    config as any,
    { getRiskPercent: () => 1.5, isRunning: () => true } as any, // LiveControl
    orchestrator as any,
    { } as any, // MailService
    { createJournalEntriesForSignal: jest.fn().mockResolvedValue(undefined) } as any,
    { findEnabled: jest.fn() } as any, // BrokerAccountsService
    brokerHttp as any,
    {} as any, // orchestrator registry (unused in shared mode)
    decisionLog as any,
  );
  const placeSpy = jest
    .spyOn(svc as any, 'placeOrderForAccount')
    .mockResolvedValue({ successfulLegs: 2 });
  jest.spyOn(svc as any, 'notifyTradeOpened').mockResolvedValue(undefined);
  return { svc, orchestrator, brokerHttp, decisionLog, prisma, placeSpy };
}

describe('shared-signal mode', () => {
  it('evaluates ONCE and executes the SAME signal on every account, sized per account', async () => {
    const { svc, orchestrator, placeSpy, brokerHttp } = makeService();
    // account A: $2,000 BALANCED (1.0%) → factor 2000×1 / (10000×1.5) = 0.133
    // account B: $10,000 AGGRESSIVE (1.5%) → factor 10000×1.5 / 15000 = 1.0
    brokerHttp.fetchAccount
      .mockResolvedValueOnce({ equity: 2000 })
      .mockResolvedValueOnce({ equity: 10000 });
    const accounts = [
      makeAccount({ id: 'a', name: 'A', presetKey: 'BALANCED' }),
      makeAccount({ id: 'b', name: 'B', userId: 'user-2', presetKey: 'AGGRESSIVE' }),
    ];
    await svc.evaluatePairSharedSignal('GBPUSD', accounts);

    expect(orchestrator.evaluate).toHaveBeenCalledTimes(1); // one brain
    expect(placeSpy).toHaveBeenCalledTimes(2);
    const sigA = placeSpy.mock.calls.find((c) => c[1] === 'a')![0] as SmcLiveSignal;
    const sigB = placeSpy.mock.calls.find((c) => c[1] === 'b')![0] as SmcLiveSignal;
    // Identical signal shape for both
    for (const sig of [sigA, sigB]) {
      expect(sig.side).toBe('SELL');
      expect(sig.entryPrice).toBe(1.33794);
      expect(sig.slPrice).toBe(1.33944);
    }
    // Proportional sizing: A ≈ 6.7% of notional lots (floored at 0.01), B = 100%
    expect(sigA.legs.map((l: any) => l.lotSize)).toEqual([0.01, 0.01]);
    expect(sigB.legs.map((l: any) => l.lotSize)).toEqual([0.05, 0.1]);
    // Pending consumed exactly once after ≥1 success
    expect(orchestrator.recordEntry).toHaveBeenCalledTimes(1);
  });

  it('an account with a same-direction open position SKIPS; the other still executes', async () => {
    const { svc, orchestrator, placeSpy, brokerHttp, decisionLog } = makeService();
    brokerHttp.fetchOpenPositions
      .mockResolvedValueOnce([{ side: 'SELL' }]) // account a already short
      .mockResolvedValueOnce([]);
    const accounts = [makeAccount({ id: 'a' }), makeAccount({ id: 'b', userId: 'u2' })];
    await svc.evaluatePairSharedSignal('GBPUSD', accounts);

    expect(placeSpy).toHaveBeenCalledTimes(1);
    expect(placeSpy.mock.calls[0][1]).toBe('b');
    expect(orchestrator.recordEntry).toHaveBeenCalledTimes(1);
    expect(decisionLog.record).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'a', decision: 'SKIPPED_SAME_DIRECTION' }),
    );
  });

  it('keeps the pending alive when EVERY account skips or fails', async () => {
    const { svc, orchestrator, placeSpy } = makeService();
    placeSpy.mockResolvedValue({ successfulLegs: 0 });
    await svc.evaluatePairSharedSignal('GBPUSD', [makeAccount()]);
    expect(orchestrator.recordEntry).not.toHaveBeenCalled();
  });

  it('skips a tiny account when broker-minimum lots would blow past the risk target', async () => {
    const { svc, placeSpy, brokerHttp, decisionLog } = makeService();
    brokerHttp.fetchAccount.mockResolvedValue({ equity: 50 }); // $50 account
    await svc.evaluatePairSharedSignal('GBPUSD', [makeAccount()]);
    expect(placeSpy).not.toHaveBeenCalled();
    expect(decisionLog.record).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'SKIPPED_MIN_LOT' }),
    );
  });

  it('applies the per-account daily-loss brake', async () => {
    const { svc, placeSpy, prisma, decisionLog } = makeService();
    prisma.trade.aggregate.mockResolvedValue({ _sum: { pnl: -350 } }); // -3.5% on $10k, BALANCED cap 3%
    await svc.evaluatePairSharedSignal('GBPUSD', [makeAccount()]);
    expect(placeSpy).not.toHaveBeenCalled();
    expect(decisionLog.record).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'SKIPPED_DAILY_LOSS' }),
    );
  });

  it('records ONE canonical decision row (accountId null) per bar', async () => {
    const { svc, decisionLog } = makeService();
    await svc.evaluatePairSharedSignal('GBPUSD', [makeAccount()]);
    const canonical = decisionLog.record.mock.calls.filter(
      (c: any[]) => c[0].accountId === null,
    );
    expect(canonical).toHaveLength(1);
    expect(canonical[0][0]).toMatchObject({ decision: 'SIGNAL', signalSide: 'SELL' });
  });
});
