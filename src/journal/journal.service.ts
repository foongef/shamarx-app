import { Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '@app/prisma';
import { JournalEntryContext, JournalExitContext, JournalOutcome } from './dto/journal-context.types';

@Injectable()
export class JournalService {
  private readonly logger = new Logger(JournalService.name);

  constructor(private readonly prisma: PrismaService) {}

  async upsertDayNote(yyyymmdd: string, note: string): Promise<{ date: string; note: string | null }> {
    const date = new Date(yyyymmdd);
    if (Number.isNaN(date.getTime())) {
      throw new UnprocessableEntityException(`Invalid date: ${yyyymmdd}`);
    }
    const todayUtc = new Date();
    todayUtc.setUTCHours(0, 0, 0, 0);
    if (date.getTime() > todayUtc.getTime()) {
      throw new UnprocessableEntityException('Cannot journal future dates');
    }

    if (note === '') {
      try {
        await this.prisma.dayNote.delete({ where: { date } });
      } catch (err: any) {
        if (err?.code !== 'P2025') throw err;
      }
      return { date: yyyymmdd, note: null };
    }

    await this.prisma.dayNote.upsert({
      where: { date },
      create: { date, note },
      update: { note },
    });
    return { date: yyyymmdd, note };
  }

  async updateTradeJournal(
    tradeId: string,
    body: { tags?: string[]; reflectionNote?: string | null },
  ): Promise<{ tags: string[]; reflectionNote: string | null; entryContext: any; exitContext: any; setupSummary: string }> {
    const trade = await this.prisma.trade.findUnique({ where: { id: tradeId } });
    if (!trade) throw new NotFoundException(`Trade not found: ${tradeId}`);

    const update: Record<string, any> = {};
    if (body.tags !== undefined) update.tags = body.tags;
    if (body.reflectionNote !== undefined) update.reflectionNote = body.reflectionNote;

    const create: Record<string, any> = {
      tradeId,
      setupSummary: '',
      llmReasoning: '',
      tags: body.tags ?? [],
      reflectionNote: body.reflectionNote ?? null,
    };

    const updated = await this.prisma.journalEntry.upsert({
      where: { tradeId },
      create: create as any,
      update,
    });

    return {
      tags: updated.tags,
      reflectionNote: updated.reflectionNote,
      entryContext: updated.entryContext as any,
      exitContext: updated.exitContext as any,
      setupSummary: updated.setupSummary,
    };
  }

  async getDay(yyyymmdd: string): Promise<{
    date: string;
    dayNote: string | null;
    trades: any[];
    dayTotals: { tradesCount: number; realizedPnl: number; winsCount: number; lossesCount: number };
  }> {
    const dayStart = new Date(`${yyyymmdd}T00:00:00.000Z`);
    if (Number.isNaN(dayStart.getTime())) {
      throw new UnprocessableEntityException(`Invalid date: ${yyyymmdd}`);
    }
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

    const [trades, dayNote] = await Promise.all([
      this.prisma.trade.findMany({
        where: { createdAt: { gte: dayStart, lt: dayEnd } },
        include: { journalEntry: true, candidate: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.dayNote.findUnique({ where: { date: dayStart } }),
    ]);

    const tradeRows = trades.map((t: any) => ({
      id: t.id,
      symbol: t.symbol,
      side: t.side,
      mode: (t.candidate?.setupTags ?? []).includes('CONTINUATION') ? 'CONTINUATION' : 'REVERSAL',
      lotSize: t.lotSize,
      entryPrice: t.entryPrice,
      closePrice: t.closePrice,
      slPrice: t.slPrice,
      originalSlPrice: t.originalSlPrice,
      tpPrice: t.tpPrice,
      pnl: t.pnl,
      exitReason: t.exitReason,
      status: t.status,
      openedAt: t.createdAt.toISOString(),
      closedAt: t.closedAt ? t.closedAt.toISOString() : null,
      sweptLevel: t.sweptLevel,
      sweepCandleTime: t.sweepCandleTime ? t.sweepCandleTime.toISOString() : null,
      d1Bias: t.d1Bias,
      journal: {
        tags: t.journalEntry?.tags ?? [],
        reflectionNote: t.journalEntry?.reflectionNote ?? null,
        entryContext: (t.journalEntry?.entryContext as any) ?? null,
        exitContext: (t.journalEntry?.exitContext as any) ?? null,
        setupSummary: t.journalEntry?.setupSummary ?? '',
        outcome: (t.journalEntry?.outcome as JournalOutcome | null) ?? null,
      },
    }));

    const realized = tradeRows.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const wins = tradeRows.filter((t) => (t.pnl ?? 0) > 0.5).length;
    const losses = tradeRows.filter((t) => (t.pnl ?? 0) < -0.5).length;

    return {
      date: yyyymmdd,
      dayNote: dayNote?.note ?? null,
      trades: tradeRows,
      dayTotals: {
        tradesCount: tradeRows.length,
        realizedPnl: Math.round(realized * 100) / 100,
        winsCount: wins,
        lossesCount: losses,
      },
    };
  }
}
