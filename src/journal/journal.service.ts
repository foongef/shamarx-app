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
}
