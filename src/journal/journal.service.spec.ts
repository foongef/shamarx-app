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
