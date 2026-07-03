import { DecisionLogService } from './decision-log.service';

function makePrisma() {
  return {
    decisionLog: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 3 }),
    },
  };
}

describe('DecisionLogService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let svc: DecisionLogService;

  beforeEach(() => {
    prisma = makePrisma();
    svc = new DecisionLogService(prisma as any);
  });

  afterEach(async () => {
    await svc.flush();
  });

  it('buffers records and writes them on flush with mapped fields', async () => {
    svc.record({
      source: 'live',
      accountId: 'acct-1',
      symbol: 'EURUSD',
      barTime: new Date('2026-06-18T07:00:00Z'),
      decision: 'SIGNAL',
      signalSide: 'BUY',
      context: { pendingCount: 1 },
    });
    expect(prisma.decisionLog.createMany).not.toHaveBeenCalled(); // buffered
    await svc.flush();
    expect(prisma.decisionLog.createMany).toHaveBeenCalledTimes(1);
    const rows = prisma.decisionLog.createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'live',
      accountId: 'acct-1',
      replaySessionId: null,
      symbol: 'EURUSD',
      decision: 'SIGNAL',
      signalSide: 'BUY',
      context: { pendingCount: 1 },
    });
  });

  it('flushes automatically at the batch threshold', async () => {
    for (let i = 0; i < 50; i++) {
      svc.record({
        source: 'live', symbol: 'EURUSD',
        barTime: new Date(), decision: 'no-sweep',
      });
    }
    await new Promise((r) => setImmediate(r));
    expect(prisma.decisionLog.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.decisionLog.createMany.mock.calls[0][0].data).toHaveLength(50);
  });

  it('drops the batch instead of throwing when the DB write fails', async () => {
    prisma.decisionLog.createMany.mockRejectedValueOnce(new Error('db down'));
    svc.record({ source: 'live', symbol: 'EURUSD', barTime: new Date(), decision: 'no-sweep' });
    await expect(svc.flush()).resolves.toBeUndefined();
  });

  it('recordBatch maps replay rows', async () => {
    prisma.decisionLog.createMany.mockResolvedValueOnce({ count: 2 });
    const n = await svc.recordBatch([
      { source: 'replay', replaySessionId: 'rs-1', symbol: 'GBPUSD', barTime: new Date(), decision: 'pending-only' },
      { source: 'replay', replaySessionId: 'rs-1', symbol: 'GBPUSD', barTime: new Date(), decision: 'SIGNAL', signalSide: 'SELL' },
    ]);
    expect(n).toBe(2);
    const rows = prisma.decisionLog.createMany.mock.calls[0][0].data;
    expect(rows[0]).toMatchObject({ source: 'replay', replaySessionId: 'rs-1', accountId: null });
  });

  it('prune deletes rows older than retention', async () => {
    await svc.prune();
    const arg = prisma.decisionLog.deleteMany.mock.calls[0][0];
    const cutoff = arg.where.createdAt.lt as Date;
    const ageDays = (Date.now() - cutoff.getTime()) / 86_400_000;
    expect(ageDays).toBeGreaterThan(44);
    expect(ageDays).toBeLessThan(46);
  });
});
