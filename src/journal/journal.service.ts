import { Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '@app/prisma';
import { JournalEntryContext, JournalExitContext, JournalOutcome } from './dto/journal-context.types';

@Injectable()
export class JournalService {
  private readonly logger = new Logger(JournalService.name);

  constructor(private readonly prisma: PrismaService) {}
}
