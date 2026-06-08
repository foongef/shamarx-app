import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { of, throwError } from 'rxjs';
import { PrismaService } from '@app/prisma';
import { RedisService } from '@app/redis';
import { PositionMonitorService } from './position-monitor.service';
import { LiveControlService } from './live-control.service';
import { LiveSmcOrchestrator } from './live-smc-orchestrator';

describe('PositionMonitorService.maybeTriggerSisterRunnerBe', () => {
  let service: PositionMonitorService;
  let prisma: any;
  let http: { post: jest.Mock; get: jest.Mock };

  const baseCreatedAt = new Date('2026-06-03T09:30:06.004Z');

  const tp1Trade = {
    id: 'tp1-id',
    mt5Ticket: 1111,
    symbol: 'USDJPY',
    side: 'BUY',
    entryPrice: 159.874,
    slPrice: 159.522,
    tpPrice: 160.156,
    status: 'CLOSED',
    createdAt: baseCreatedAt,
    managementState: { trailKey: 'TP1', originalSlPrice: 159.522, breakevenActivated: false, peakFavorablePrice: 160.068 },
  };

  const runnerSister = {
    id: 'runner-id',
    mt5Ticket: 2222,
    symbol: 'USDJPY',
    side: 'BUY',
    entryPrice: 159.874,
    slPrice: 159.522,
    tpPrice: 161.106,
    status: 'OPEN',
    createdAt: new Date(baseCreatedAt.getTime() + 800), // 0.8s after TP1
    managementState: { trailKey: 'RUNNER', originalSlPrice: 159.522, breakevenActivated: false, peakFavorablePrice: 160.369 },
  };

  beforeEach(async () => {
    prisma = {
      trade: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
      },
    };
    http = { post: jest.fn(), get: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        PositionMonitorService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: { subscribe: jest.fn() } },
        { provide: HttpService, useValue: http },
        { provide: ConfigService, useValue: { get: () => 'false' } },
        { provide: LiveControlService, useValue: { isRunning: () => false } },
        { provide: LiveSmcOrchestrator, useValue: {} },
      ],
    }).compile();

    service = moduleRef.get(PositionMonitorService);
  });

  it('activates BE on sister Runner when TP1 closed at TP', async () => {
    prisma.trade.findUnique.mockResolvedValue(tp1Trade);
    prisma.trade.findFirst.mockResolvedValue(runnerSister);
    http.post.mockReturnValue(of({ data: { ok: true } }));
    prisma.trade.update.mockResolvedValue({});

    await (service as any).maybeTriggerSisterRunnerBe('tp1-id');

    // Broker called with new SL = entry + 10% of risk = 159.874 + 0.0352 = 159.9092
    expect(http.post).toHaveBeenCalledWith(
      expect.stringContaining('/positions/2222/modify'),
      { slPrice: expect.closeTo(159.9092, 3), tpPrice: 161.106 },
    );
    expect(prisma.trade.update).toHaveBeenCalledWith({
      where: { id: 'runner-id' },
      data: {
        slPrice: expect.closeTo(159.9092, 3),
        managementState: expect.objectContaining({
          breakevenActivated: true,
          trailKey: 'RUNNER',
          peakFavorablePrice: 160.369, // preserved
        }),
      },
    });
  });

  it('computes BE-buffer SL correctly for SELL Runners', async () => {
    const sellTp1 = { ...tp1Trade, side: 'SELL', entryPrice: 160.0, slPrice: 160.4, managementState: { trailKey: 'TP1', originalSlPrice: 160.4, breakevenActivated: false } };
    const sellRunner = { ...runnerSister, side: 'SELL', entryPrice: 160.0, slPrice: 160.4, managementState: { trailKey: 'RUNNER', originalSlPrice: 160.4, breakevenActivated: false } };
    prisma.trade.findUnique.mockResolvedValue(sellTp1);
    prisma.trade.findFirst.mockResolvedValue(sellRunner);
    http.post.mockReturnValue(of({ data: {} }));
    prisma.trade.update.mockResolvedValue({});

    await (service as any).maybeTriggerSisterRunnerBe('tp1-id');

    // SELL: newSl = entry - 10% of risk = 160.0 - 0.04 = 159.96
    expect(http.post).toHaveBeenCalledWith(
      expect.any(String),
      { slPrice: expect.closeTo(159.96, 3), tpPrice: expect.any(Number) },
    );
  });

  it('is a no-op when closed trade is not a TP1 leg', async () => {
    const notTp1 = { ...tp1Trade, managementState: { trailKey: 'RUNNER' } };
    prisma.trade.findUnique.mockResolvedValue(notTp1);

    await (service as any).maybeTriggerSisterRunnerBe('not-tp1-id');

    expect(prisma.trade.findFirst).not.toHaveBeenCalled();
    expect(http.post).not.toHaveBeenCalled();
  });

  it('is a no-op when no sister Runner found', async () => {
    prisma.trade.findUnique.mockResolvedValue(tp1Trade);
    prisma.trade.findFirst.mockResolvedValue(null);

    await (service as any).maybeTriggerSisterRunnerBe('tp1-id');

    expect(http.post).not.toHaveBeenCalled();
  });

  it('is idempotent — skips when sister Runner already at BE', async () => {
    const alreadyAtBe = { ...runnerSister, managementState: { ...runnerSister.managementState, breakevenActivated: true } };
    prisma.trade.findUnique.mockResolvedValue(tp1Trade);
    prisma.trade.findFirst.mockResolvedValue(alreadyAtBe);

    await (service as any).maybeTriggerSisterRunnerBe('tp1-id');

    expect(http.post).not.toHaveBeenCalled();
    expect(prisma.trade.update).not.toHaveBeenCalled();
  });

  it('does NOT update DB when broker rejects the modify', async () => {
    prisma.trade.findUnique.mockResolvedValue(tp1Trade);
    prisma.trade.findFirst.mockResolvedValue(runnerSister);
    http.post.mockReturnValue(throwError(() => new Error('broker said no')));

    await (service as any).maybeTriggerSisterRunnerBe('tp1-id');

    expect(prisma.trade.update).not.toHaveBeenCalled();
  });
});
