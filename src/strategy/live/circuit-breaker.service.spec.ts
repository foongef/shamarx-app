import { CircuitBreakerService } from './circuit-breaker.service';

function makeDeps(over: any = {}) {
  const prisma = {
    trade: { aggregate: jest.fn().mockResolvedValue({ _sum: { pnl: over.rollingPnl ?? -50 } }) },
    equitySnapshot: {
      findMany: jest.fn().mockResolvedValue(over.snaps ?? [{ equity: 1000 }, { equity: 950 }]),
    },
    user: {
      findMany: jest.fn().mockResolvedValue([{ email: 'admin@x.com' }]),
    },
  };
  const store: Record<string, string> = {};
  const redis = {
    get: jest.fn(async (k: string) => store[k] ?? null),
    set: jest.fn(async (k: string, v: string) => { store[k] = v; }),
    del: jest.fn(async (k: string) => { delete store[k]; }),
  };
  const config = { get: (k: string) => (over.config ?? {})[k] };
  const mail = { sendAlert: jest.fn().mockResolvedValue(undefined) };
  return { prisma, redis, config, mail, store };
}
const make = (d: ReturnType<typeof makeDeps>) =>
  new CircuitBreakerService(d.prisma as any, d.redis as any, d.config as any, d.mail as any);

describe('CircuitBreakerService', () => {
  it('does NOT trip on normal variance (-50 on ~2k equity, 15% threshold = -292)', async () => {
    const d = makeDeps({ rollingPnl: -50 });
    const st = await make(d).checkOnce();
    expect(st.tripped).toBe(false);
    expect(d.mail.sendAlert).not.toHaveBeenCalled();
  });

  it('trips on sustained bleed and emails admins exactly once', async () => {
    const d = makeDeps({ rollingPnl: -400 }); // beyond -292.5 threshold
    const svc = make(d);
    const st = await svc.checkOnce();
    expect(st.tripped).toBe(true);
    expect(st.trippedAt).toBeTruthy();
    expect(d.mail.sendAlert).toHaveBeenCalledTimes(1);
    expect(d.mail.sendAlert.mock.calls[0][1]).toContain('circuit breaker');
    // second check while already tripped: latched, NO duplicate email
    await svc.checkOnce();
    expect(d.mail.sendAlert).toHaveBeenCalledTimes(1);
  });

  it('stays LATCHED even if rolling PnL recovers (manual resume only)', async () => {
    const d = makeDeps({ rollingPnl: -400 });
    const svc = make(d);
    await svc.checkOnce();
    d.prisma.trade.aggregate.mockResolvedValue({ _sum: { pnl: +100 } }); // recovered
    const st = await svc.checkOnce();
    expect(st.tripped).toBe(true); // still paused — human decides
    expect(await svc.isTripped()).toBe(true);
  });

  it('reset clears the latch', async () => {
    const d = makeDeps({ rollingPnl: -400 });
    const svc = make(d);
    await svc.checkOnce();
    await svc.reset();
    expect(await svc.isTripped()).toBe(false);
  });

  it('kill-switch CIRCUIT_BREAKER=false disables the gate', async () => {
    const d = makeDeps({ rollingPnl: -400, config: { CIRCUIT_BREAKER: 'false' } });
    const svc = make(d);
    expect(await svc.isTripped()).toBe(false);
  });

  it('excludes reconciliation artifacts from the rolling sum', async () => {
    const d = makeDeps();
    await make(d).checkOnce();
    const where = d.prisma.trade.aggregate.mock.calls[0][0].where;
    expect(where.status).toBe('CLOSED');
    expect(where.OR).toEqual([
      { exitReason: null },
      { exitReason: { notIn: ['ORPHAN', 'STALE_BROKER'] } },
    ]);
  });
});
