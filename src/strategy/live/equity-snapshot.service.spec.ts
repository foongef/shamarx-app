import { Test } from '@nestjs/testing';
import { EquitySnapshotService } from './equity-snapshot.service';
import { PrismaService } from '@app/prisma';
import { LiveControlService } from './live-control.service';
import { BrokerHttpClient } from './broker-http-client';

describe('EquitySnapshotService', () => {
  let svc: EquitySnapshotService;
  let prismaMock: any;
  let controlMock: any;
  let brokerMock: any;

  beforeEach(async () => {
    prismaMock = {
      brokerAccount: { findMany: jest.fn() },
      equitySnapshot: { create: jest.fn().mockResolvedValue({}) },
    };
    controlMock = {
      isEnabled: jest.fn().mockReturnValue(true),
      isRunning: jest.fn().mockReturnValue(true),
      getConfig: jest.fn().mockReturnValue({ mode: 'metaapi' }),
    };
    brokerMock = {
      fetchAccount: jest.fn(),
      fetchOpenPositions: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        EquitySnapshotService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: LiveControlService, useValue: controlMock },
        { provide: BrokerHttpClient, useValue: brokerMock },
      ],
    }).compile();
    svc = moduleRef.get(EquitySnapshotService);
  });

  it('skips when engine not running', async () => {
    controlMock.isRunning.mockReturnValue(false);
    await svc.takeSnapshot();
    expect(prismaMock.brokerAccount.findMany).not.toHaveBeenCalled();
  });

  it('skips when no enabled accounts', async () => {
    prismaMock.brokerAccount.findMany.mockResolvedValue([]);
    await svc.takeSnapshot();
    expect(brokerMock.fetchAccount).not.toHaveBeenCalled();
    expect(prismaMock.equitySnapshot.create).not.toHaveBeenCalled();
  });

  it('writes one snapshot per enabled account, stamped with accountId', async () => {
    prismaMock.brokerAccount.findMany.mockResolvedValue([
      { id: 'a1', name: 'Live' },
      { id: 'a2', name: 'Demo' },
    ]);
    brokerMock.fetchAccount
      .mockResolvedValueOnce({ balance: 1000, equity: 1010, margin: 50, freeMargin: 960 })
      .mockResolvedValueOnce({ balance: 500, equity: 498, margin: 20, freeMargin: 480 });
    brokerMock.fetchOpenPositions
      .mockResolvedValueOnce([{ pnl: 10 }])
      .mockResolvedValueOnce([]);

    await svc.takeSnapshot();

    expect(prismaMock.equitySnapshot.create).toHaveBeenCalledTimes(2);
    const calls = prismaMock.equitySnapshot.create.mock.calls;
    expect(calls[0][0].data).toEqual(expect.objectContaining({
      accountId: 'a1', balance: 1000, equity: 1010, unrealizedPnl: 10, mode: 'metaapi',
    }));
    expect(calls[1][0].data).toEqual(expect.objectContaining({
      accountId: 'a2', balance: 500, equity: 498, unrealizedPnl: 0,
    }));
  });

  it('skips bogus zero readings (transient broker disconnect)', async () => {
    prismaMock.brokerAccount.findMany.mockResolvedValue([{ id: 'a1', label: 'Live' }]);
    brokerMock.fetchAccount.mockResolvedValue({ balance: 0, equity: 0, margin: 0, freeMargin: 0 });

    await svc.takeSnapshot();

    expect(prismaMock.equitySnapshot.create).not.toHaveBeenCalled();
    expect(brokerMock.fetchOpenPositions).not.toHaveBeenCalled();
  });

  it('isolates per-account failures — one bad broker does not block others', async () => {
    prismaMock.brokerAccount.findMany.mockResolvedValue([
      { id: 'a1', name: 'Live' },
      { id: 'a2', name: 'Demo' },
    ]);
    brokerMock.fetchAccount
      .mockRejectedValueOnce(new Error('broker timeout'))
      .mockResolvedValueOnce({ balance: 500, equity: 498, margin: 0, freeMargin: 500 });
    brokerMock.fetchOpenPositions.mockResolvedValue([]);

    await svc.takeSnapshot();

    expect(prismaMock.equitySnapshot.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.equitySnapshot.create.mock.calls[0][0].data.accountId).toBe('a2');
  });

  it('falls back to mock mode if config has no mode', async () => {
    controlMock.getConfig.mockReturnValue(null);
    prismaMock.brokerAccount.findMany.mockResolvedValue([{ id: 'a1', label: 'Live' }]);
    brokerMock.fetchAccount.mockResolvedValue({ balance: 100, equity: 100, margin: 0, freeMargin: 100 });
    brokerMock.fetchOpenPositions.mockResolvedValue([]);

    await svc.takeSnapshot();

    expect(prismaMock.equitySnapshot.create.mock.calls[0][0].data.mode).toBe('mock');
  });
});
