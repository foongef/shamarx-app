import { of, throwError } from 'rxjs';
import { ExitReconciliationService } from './exit-reconciliation.service';

const EST_TRADE = {
  id: 'trade-1',
  mt5Ticket: 649155875,
  symbol: 'EURUSD',
  exitReason: 'TP_EST',
  accountId: 'acct-1',
  pnl: 12.23,
};

function makeDeps(trades: any[] = [EST_TRADE]) {
  const prisma = {
    trade: {
      findMany: jest.fn().mockResolvedValue(trades),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const brokerHttp = { fetchPositionHistory: jest.fn() };
  const httpService = { get: jest.fn() };
  return { prisma, brokerHttp, httpService };
}

function make(deps: ReturnType<typeof makeDeps>) {
  return new ExitReconciliationService(
    deps.prisma as any,
    deps.brokerHttp as any,
    deps.httpService as any,
  );
}

describe('ExitReconciliationService', () => {
  it('replaces an estimated exit with account-scoped broker truth (cTrader shape)', async () => {
    const deps = makeDeps();
    // cTrader get_position_close_info shape: pnl + reason + epoch-ms string
    deps.brokerHttp.fetchPositionHistory.mockResolvedValue({
      ticket: 649155875,
      closePrice: 1.14464,
      pnl: 8.11,
      reason: 'TAKE_PROFIT',
      closeTime: '1783075077340',
    });
    const fixed = await make(deps).sweepOnce();

    expect(fixed).toBe(1);
    expect(deps.brokerHttp.fetchPositionHistory).toHaveBeenCalledWith('acct-1', 649155875);
    const update = deps.prisma.trade.update.mock.calls[0][0];
    expect(update.where).toEqual({ id: 'trade-1' });
    expect(update.data.exitReason).toBe('TP');       // normalized, never *_EST
    expect(update.data.pnl).toBe(8.11);
    expect(update.data.closePrice).toBe(1.14464);
    expect(update.data.closedAt).toEqual(new Date(1783075077340));
  });

  it('accepts the MetaApi shape (realizedPnl/exitReason) via the legacy endpoint', async () => {
    const deps = makeDeps([{ ...EST_TRADE, accountId: null, exitReason: 'SL_EST' }]);
    deps.httpService.get.mockReturnValue(of({
      data: { closePrice: 1.081, realizedPnl: -5.4, exitReason: 'STOP_LOSS', closeTime: '2026-06-18T10:00:00Z' },
    }));
    const fixed = await make(deps).sweepOnce();

    expect(fixed).toBe(1);
    expect(deps.brokerHttp.fetchPositionHistory).not.toHaveBeenCalled();
    const update = deps.prisma.trade.update.mock.calls[0][0];
    expect(update.data.exitReason).toBe('SL');
    expect(update.data.pnl).toBe(-5.4);
  });

  it('leaves the trade untouched when the broker has no close info yet', async () => {
    const deps = makeDeps();
    deps.brokerHttp.fetchPositionHistory.mockResolvedValue(null);
    deps.httpService.get.mockReturnValue(of({ data: null }));
    const fixed = await make(deps).sweepOnce();

    expect(fixed).toBe(0);
    expect(deps.prisma.trade.update).not.toHaveBeenCalled();
  });

  it('falls back to the legacy endpoint when the account-scoped fetch fails', async () => {
    const deps = makeDeps();
    deps.brokerHttp.fetchPositionHistory.mockRejectedValue(new Error('500'));
    deps.httpService.get.mockReturnValue(of({
      data: { closePrice: 1.09, pnl: 3.2, reason: 'TP', closeTime: null },
    }));
    const fixed = await make(deps).sweepOnce();
    expect(fixed).toBe(1);
    const update = deps.prisma.trade.update.mock.calls[0][0];
    expect(update.data.exitReason).toBe('TP');
    expect(update.data.closedAt).toBeUndefined(); // no closeTime → keep original
  });

  it('one broken trade does not block the rest of the sweep', async () => {
    const deps = makeDeps([
      EST_TRADE,
      { ...EST_TRADE, id: 'trade-2', mt5Ticket: 111 },
    ]);
    deps.brokerHttp.fetchPositionHistory
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ closePrice: 1.1, pnl: 1.0, reason: 'TP', closeTime: null });
    deps.httpService.get.mockReturnValue(throwError(() => new Error('legacy down')));
    const fixed = await make(deps).sweepOnce();
    expect(fixed).toBe(1);
    expect(deps.prisma.trade.update).toHaveBeenCalledTimes(1);
  });

  it('only targets recent _EST trades', async () => {
    const deps = makeDeps([]);
    await make(deps).sweepOnce();
    const where = deps.prisma.trade.findMany.mock.calls[0][0].where;
    expect(where.exitReason).toEqual({ in: ['TP_EST', 'SL_EST'] });
    expect(where.status).toBe('CLOSED');
    expect(where.mt5Ticket).toEqual({ not: null });
    const since = where.closedAt.gte as Date;
    const ageHours = (Date.now() - since.getTime()) / 3_600_000;
    expect(ageHours).toBeGreaterThan(71);
    expect(ageHours).toBeLessThan(73);
  });
});

describe('staleSweepOnce', () => {
  it('finalizes OPEN trades on brokers unreachable for 7+ days, pnl untouched', async () => {
    const deps = makeDeps([]);
    (deps.prisma.trade as any).updateMany = jest.fn().mockResolvedValue({ count: 4 });
    const n = await make(deps).staleSweepOnce();
    expect(n).toBe(4);
    const arg = (deps.prisma.trade as any).updateMany.mock.calls[0][0];
    expect(arg.where.status).toBe('OPEN');
    expect(arg.where.account.equitySnapshots.none.takenAt.gte).toBeInstanceOf(Date);
    expect(arg.data).toMatchObject({ status: 'CLOSED', exitReason: 'STALE_BROKER' });
    expect(arg.data.pnl).toBeUndefined(); // never invent a number
    // both cutoffs ~7 days
    const age = (Date.now() - arg.where.createdAt.lt.getTime()) / 86_400_000;
    expect(age).toBeGreaterThan(6.9);
    expect(age).toBeLessThan(7.1);
  });
});
