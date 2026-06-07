import { Test } from '@nestjs/testing';
import { PrismaService } from '@app/prisma';
import { JournalService } from './journal.service';
import { UnprocessableEntityException } from '@nestjs/common';

describe('JournalService.upsertDayNote', () => {
  let service: JournalService;
  let prisma: { dayNote: { upsert: jest.Mock; delete: jest.Mock } };

  beforeEach(async () => {
    prisma = {
      dayNote: {
        upsert: jest.fn(),
        delete: jest.fn(),
      },
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        JournalService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = moduleRef.get(JournalService);
  });

  it('creates a day note for a past date', async () => {
    prisma.dayNote.upsert.mockResolvedValue({ id: '1', date: new Date('2026-06-05'), note: 'hi' });
    const result = await service.upsertDayNote('2026-06-05', 'hi');
    expect(prisma.dayNote.upsert).toHaveBeenCalledWith({
      where: { date: new Date('2026-06-05') },
      create: { date: new Date('2026-06-05'), note: 'hi' },
      update: { note: 'hi' },
    });
    expect(result).toEqual({ date: '2026-06-05', note: 'hi' });
  });

  it('deletes the day note when given empty string', async () => {
    prisma.dayNote.delete.mockResolvedValue({});
    const result = await service.upsertDayNote('2026-06-05', '');
    expect(prisma.dayNote.delete).toHaveBeenCalledWith({
      where: { date: new Date('2026-06-05') },
    });
    expect(result).toEqual({ date: '2026-06-05', note: null });
  });

  it('swallows P2025 (delete non-existing) as no-op', async () => {
    prisma.dayNote.delete.mockRejectedValue({ code: 'P2025' });
    const result = await service.upsertDayNote('2026-06-05', '');
    expect(result).toEqual({ date: '2026-06-05', note: null });
  });

  it('rejects future dates with 422', async () => {
    const future = new Date(Date.now() + 86400000 * 30).toISOString().slice(0, 10);
    await expect(service.upsertDayNote(future, 'x')).rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});

describe('JournalService.updateTradeJournal', () => {
  let service: JournalService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      trade: { findUnique: jest.fn() },
      journalEntry: { upsert: jest.fn(), findUnique: jest.fn() },
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        JournalService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = moduleRef.get(JournalService);
  });

  it('replaces tags array (not merge)', async () => {
    prisma.trade.findUnique.mockResolvedValue({ id: 't1', sessionId: 'live-1' });
    prisma.journalEntry.upsert.mockResolvedValue({
      tags: ['News spike'], reflectionNote: null, entryContext: null, exitContext: null, setupSummary: '',
    });
    const result = await service.updateTradeJournal('t1', { tags: ['News spike'] });
    expect(prisma.journalEntry.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: { tags: ['News spike'] },
    }));
    expect(result.tags).toEqual(['News spike']);
  });

  it('updates reflectionNote independently from tags', async () => {
    prisma.trade.findUnique.mockResolvedValue({ id: 't1', sessionId: 'live-1' });
    prisma.journalEntry.upsert.mockResolvedValue({ tags: [], reflectionNote: 'note', entryContext: null, exitContext: null, setupSummary: '' });
    await service.updateTradeJournal('t1', { reflectionNote: 'note' });
    expect(prisma.journalEntry.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: { reflectionNote: 'note' },
    }));
  });

  it('clears reflectionNote when given null', async () => {
    prisma.trade.findUnique.mockResolvedValue({ id: 't1', sessionId: 'live-1' });
    prisma.journalEntry.upsert.mockResolvedValue({ tags: [], reflectionNote: null, entryContext: null, exitContext: null, setupSummary: '' });
    await service.updateTradeJournal('t1', { reflectionNote: null });
    expect(prisma.journalEntry.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: { reflectionNote: null },
    }));
  });

  it('throws 404 when trade does not exist', async () => {
    prisma.trade.findUnique.mockResolvedValue(null);
    await expect(service.updateTradeJournal('missing', { tags: [] })).rejects.toMatchObject({ status: 404 });
  });
});

describe('JournalService.getDay', () => {
  let service: JournalService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      trade: { findMany: jest.fn() },
      dayNote: { findUnique: jest.fn() },
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        JournalService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = moduleRef.get(JournalService);
  });

  it('returns trades + dayNote + dayTotals for a date', async () => {
    prisma.trade.findMany.mockResolvedValue([
      {
        id: 'T1', symbol: 'EURUSD', side: 'SELL', lotSize: 0.01,
        entryPrice: 1.16, closePrice: 1.158, slPrice: 1.165, originalSlPrice: 1.165,
        tpPrice: 1.155, pnl: 2.0, exitReason: 'TP', status: 'CLOSED',
        createdAt: new Date('2026-06-05T07:15Z'), closedAt: new Date('2026-06-05T09:48Z'),
        sweptLevel: 1.161, sweepCandleTime: new Date('2026-06-05T06:00Z'), d1Bias: 'BEARISH',
        candidate: { setupTags: ['REVERSAL'] },
        journalEntry: {
          tags: ['Setup looked good'], reflectionNote: null,
          entryContext: { d1Adx: 24 }, exitContext: { holdMinutes: 153 },
          setupSummary: 'REVERSAL SELL on EURUSD', outcome: 'WIN',
        },
      },
      {
        id: 'T2', symbol: 'GBPUSD', side: 'SELL', lotSize: 0.01,
        entryPrice: 1.275, closePrice: null, slPrice: 1.280, originalSlPrice: 1.280,
        tpPrice: 1.270, pnl: null, exitReason: null, status: 'OPEN',
        createdAt: new Date('2026-06-05T08:00Z'), closedAt: null,
        sweptLevel: null, sweepCandleTime: null, d1Bias: 'BEARISH',
        candidate: { setupTags: [] },
        journalEntry: null,
      },
    ]);
    prisma.dayNote.findUnique.mockResolvedValue({ note: 'caught by news' });

    const result = await service.getDay('2026-06-05');

    expect(result.date).toBe('2026-06-05');
    expect(result.dayNote).toBe('caught by news');
    expect(result.trades).toHaveLength(2);
    expect(result.trades[0].id).toBe('T1');
    expect(result.trades[0].journal.outcome).toBe('WIN');
    expect(result.trades[1].journal.outcome).toBeNull();
    expect(result.dayTotals).toEqual({
      tradesCount: 2,
      realizedPnl: 2.0,
      winsCount: 1,
      lossesCount: 0,
    });
  });

  it('returns null dayNote when no row exists', async () => {
    prisma.trade.findMany.mockResolvedValue([]);
    prisma.dayNote.findUnique.mockResolvedValue(null);
    const result = await service.getDay('2026-06-05');
    expect(result.dayNote).toBeNull();
    expect(result.trades).toEqual([]);
  });
});

describe('JournalService.getMonthAggregate', () => {
  let service: JournalService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      trade: { findMany: jest.fn() },
      dayNote: { findMany: jest.fn() },
      journalEntry: { findMany: jest.fn() },
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        JournalService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = moduleRef.get(JournalService);
  });

  it('aggregates trades per day with month + weekly totals', async () => {
    prisma.trade.findMany.mockResolvedValue([
      { id: 'A', createdAt: new Date('2026-06-02T10:00Z'), pnl: -22, status: 'CLOSED', journalEntry: { tags: [], reflectionNote: null } },
      { id: 'B', createdAt: new Date('2026-06-02T14:00Z'), pnl: 0, status: 'CLOSED', journalEntry: { tags: [], reflectionNote: null } },
      { id: 'C', createdAt: new Date('2026-06-03T09:00Z'), pnl: 12, status: 'CLOSED', journalEntry: { tags: ['Setup looked good'], reflectionNote: null } },
      { id: 'D', createdAt: new Date('2026-06-03T11:00Z'), pnl: 36, status: 'CLOSED', journalEntry: { tags: [], reflectionNote: 'good' } },
      { id: 'E', createdAt: new Date('2026-06-08T08:00Z'), pnl: null, status: 'OPEN', journalEntry: null },
    ]);
    prisma.dayNote.findMany.mockResolvedValue([
      { date: new Date('2026-06-03') },
    ]);

    const result = await service.getMonthAggregate('2026-06');

    expect(result.month).toBe('2026-06');
    expect(result.monthTotals.tradesCount).toBe(5);
    expect(result.monthTotals.realizedPnl).toBe(26);
    expect(result.monthTotals.winsCount).toBe(2);
    expect(result.monthTotals.lossesCount).toBe(1);
    expect(result.monthTotals.winRatePct).toBe(67);
    const jun3 = result.days.find((d) => d.date === '2026-06-03')!;
    expect(jun3.tradesCount).toBe(2);
    expect(jun3.realizedPnl).toBe(48);
    expect(jun3.hasDayNote).toBe(true);
    expect(jun3.hasReflections).toBe(true);
    const jun8 = result.days.find((d) => d.date === '2026-06-08')!;
    expect(jun8.hasOpenTrades).toBe(true);
    const wk1 = result.weeklyTotals.find((w) => w.weekStart === '2026-06-01');
    expect(wk1?.tradesCount).toBe(4);
    expect(wk1?.realizedPnl).toBe(26);
  });

  it('handles a month with zero trades', async () => {
    prisma.trade.findMany.mockResolvedValue([]);
    prisma.dayNote.findMany.mockResolvedValue([]);
    const result = await service.getMonthAggregate('2025-01');
    expect(result.monthTotals.tradesCount).toBe(0);
    expect(result.days).toHaveLength(31);
    expect(result.days.every((d) => d.tradesCount === 0)).toBe(true);
  });
});

describe('JournalService.getAvailableMonths', () => {
  let service: JournalService;
  let prisma: any;

  beforeEach(async () => {
    prisma = { trade: { aggregate: jest.fn(), groupBy: jest.fn() } };
    const moduleRef = await Test.createTestingModule({
      providers: [
        JournalService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = moduleRef.get(JournalService);
  });

  it('returns descending list of months with trades + bounds', async () => {
    prisma.trade.aggregate.mockResolvedValue({ _min: { createdAt: new Date('2026-04-12T08:00Z') }, _max: { createdAt: new Date('2026-06-05T20:00Z') } });
    const result = await service.getAvailableMonths();
    expect(result.months).toEqual(['2026-06', '2026-05', '2026-04']);
    expect(result.earliestTradeDate).toBe('2026-04-12');
    expect(result.latestTradeDate).toBe('2026-06-05');
  });

  it('returns empty list when no trades exist', async () => {
    prisma.trade.aggregate.mockResolvedValue({ _min: { createdAt: null }, _max: { createdAt: null } });
    const result = await service.getAvailableMonths();
    expect(result.months).toEqual([]);
    expect(result.earliestTradeDate).toBeNull();
  });
});
