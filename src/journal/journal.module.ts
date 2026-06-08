import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/prisma';
import { JournalController } from './journal.controller';
import { JournalService } from './journal.service';

@Module({
  imports: [PrismaModule],
  controllers: [JournalController],
  providers: [JournalService],
  exports: [JournalService],
})
export class JournalModule {}
