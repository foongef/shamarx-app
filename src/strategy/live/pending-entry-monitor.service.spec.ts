import { PendingEntryMonitorService } from './pending-entry-monitor.service';

const PENDING_TRADE = {
  id: 't1', symbol: 'GBPUSD', side: 'BUY', accountId: 'acct-1',
  brokerOrderId: '424242', limitPrice: 1.2995,
  orderExpiresAt: new Date(Date.now() + 3600_000),
  managementState: { breakevenActivated: false, peakFavorablePrice: 1.2995, originalSlPrice: 1.299, trailKey: 'RUNNER' },
  statusHistory: [{ status: 'PENDING' }],
};

function makeDeps(trades: any[] = [PENDING_TRADE]) {
  const prisma = {
    trade: {
      findMany: jest.fn().mockResolvedValue(trades),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const brokerHttp = { fetchOrderStatus: jest.fn() };
  const liveStrategy = { pushExternalEvent: jest.fn() };
  return { prisma, brokerHttp, liveStrategy };
}
const make = (d: ReturnType<typeof makeDeps>) =>
  new PendingEntryMonitorService(d.prisma as any, d.brokerHttp as any, d.liveStrategy as any);

describe('PendingEntryMonitorService', () => {
  it('promotes a filled limit to OPEN with real fill price and positionId', async () => {
    const d = makeDeps();
    d.brokerHttp.fetchOrderStatus.mockResolvedValue({
      status: 'FILLED', positionId: 999, executionPrice: 1.29948,
    });
    const res = await make(d).sweepOnce();
    expect(res.filled).toBe(1);
    const update = d.prisma.trade.update.mock.calls[0][0];
    expect(update.data.status).toBe('OPEN');
    expect(update.data.mt5Ticket).toBe(999);
    expect(update.data.entryPrice).toBe(1.29948);
    expect(update.data.managementState.peakFavorablePrice).toBe(1.29948);
    expect(d.liveStrategy.pushExternalEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'limit-filled' }),
    );
  });

  it('marks a GONE order CANCELLED/EXPIRED with pnl untouched', async () => {
    const d = makeDeps();
    d.brokerHttp.fetchOrderStatus.mockResolvedValue({ status: 'GONE' });
    const res = await make(d).sweepOnce();
    expect(res.expired).toBe(1);
    const update = d.prisma.trade.update.mock.calls[0][0];
    expect(update.data.status).toBe('CANCELLED');
    expect(update.data.exitReason).toBe('EXPIRED');
    expect(update.data.pnl).toBeUndefined();
  });

  it('leaves PENDING orders parked', async () => {
    const d = makeDeps();
    d.brokerHttp.fetchOrderStatus.mockResolvedValue({ status: 'PENDING' });
    await make(d).sweepOnce();
    expect(d.prisma.trade.update).not.toHaveBeenCalled();
  });

  it('one broker error does not block other trades', async () => {
    const d = makeDeps([PENDING_TRADE, { ...PENDING_TRADE, id: 't2', brokerOrderId: '5' }]);
    d.brokerHttp.fetchOrderStatus
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValueOnce({ status: 'FILLED', positionId: 7, executionPrice: 1.2995 });
    const res = await make(d).sweepOnce();
    expect(res.filled).toBe(1);
    expect(d.prisma.trade.update).toHaveBeenCalledTimes(1);
  });

  it('only targets PENDING retrace rows with broker ids', async () => {
    const d = makeDeps([]);
    await make(d).sweepOnce();
    const where = d.prisma.trade.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      status: 'PENDING',
      entryType: 'RETRACE_LIMIT',
      brokerOrderId: { not: null },
      accountId: { not: null },
    });
  });
});
