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
}
