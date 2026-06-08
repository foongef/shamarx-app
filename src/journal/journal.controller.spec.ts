import { Test } from '@nestjs/testing';
import { JournalController } from './journal.controller';
import { JournalService } from './journal.service';

describe('JournalController routing', () => {
  let controller: JournalController;
  let service: jest.Mocked<JournalService>;

  beforeEach(async () => {
    service = {
      getAvailableMonths: jest.fn().mockResolvedValue({ months: [], earliestTradeDate: null, latestTradeDate: null }),
      getMonthAggregate: jest.fn().mockResolvedValue({ month: '2026-06', days: [], monthTotals: {}, weeklyTotals: [] }),
      getDay: jest.fn().mockResolvedValue({ date: '2026-06-05', dayNote: null, trades: [], dayTotals: {} }),
      updateTradeJournal: jest.fn().mockResolvedValue({ tags: [], reflectionNote: null }),
      upsertDayNote: jest.fn().mockResolvedValue({ date: '2026-06-05', note: 'hi' }),
    } as any;

    const moduleRef = await Test.createTestingModule({
      controllers: [JournalController],
      providers: [{ provide: JournalService, useValue: service }],
    })
      .overrideGuard(require('../auth/guards/jwt-auth.guard').JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get(JournalController);
  });

  it('health responds OK', () => {
    expect(controller.health()).toEqual({ status: 'ok', service: 'journal' });
  });

  it('routes GET /month/:yyyymm to service', async () => {
    await controller.month('2026-06');
    expect(service.getMonthAggregate).toHaveBeenCalledWith('2026-06');
  });

  it('routes GET /day/:yyyymmdd to service', async () => {
    const mockReq = { user: { id: 'user-1' } } as unknown as import('express').Request;
    await controller.day(mockReq, '2026-06-05');
    expect(service.getDay).toHaveBeenCalledWith('user-1', '2026-06-05');
  });

  it('routes PATCH /trade/:tradeId with body', async () => {
    await controller.updateTrade('T1', { tags: ['News spike'] } as any);
    expect(service.updateTradeJournal).toHaveBeenCalledWith('T1', { tags: ['News spike'] });
  });

  it('routes PATCH /day/:yyyymmdd with note', async () => {
    const mockReq = { user: { id: 'user-1' } } as unknown as import('express').Request;
    await controller.updateDay(mockReq, '2026-06-05', { note: 'hi' } as any);
    expect(service.upsertDayNote).toHaveBeenCalledWith('user-1', '2026-06-05', 'hi');
  });
});
