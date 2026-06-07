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
