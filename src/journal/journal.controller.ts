import { Body, Controller, Get, Param, Patch, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { JournalService } from './journal.service';
import { UpdateTradeJournalDto } from './dto/update-trade-journal.dto';
import { UpdateDayNoteDto } from './dto/update-day-note.dto';

@ApiTags('Journal')
@Controller('api/journal')
@UseGuards(JwtAuthGuard)
export class JournalController {
  constructor(private readonly journal: JournalService) {}

  @Get('health')
  @ApiOperation({ summary: 'Health check' })
  health() {
    return { status: 'ok', service: 'journal' };
  }

  @Get('available-months')
  @ApiOperation({ summary: 'Months with any live trade — for month picker' })
  availableMonths() {
    return this.journal.getAvailableMonths();
  }

  @Get('month/:yyyymm')
  @ApiOperation({ summary: 'Per-day aggregate stats for a month' })
  month(@Param('yyyymm') yyyymm: string) {
    return this.journal.getMonthAggregate(yyyymm);
  }

  @Get('day/:yyyymmdd')
  @ApiOperation({ summary: 'Trades + journal entries + dayNote for a day' })
  day(@Req() req: any, @Param('yyyymmdd') yyyymmdd: string) {
    return this.journal.getDay(req.user.id, yyyymmdd);
  }

  @Patch('trade/:tradeId')
  @ApiOperation({ summary: 'Update tags + reflectionNote for a trade' })
  updateTrade(
    @Param('tradeId') tradeId: string,
    @Body() body: UpdateTradeJournalDto,
  ) {
    return this.journal.updateTradeJournal(tradeId, body);
  }

  @Patch('day/:yyyymmdd')
  @ApiOperation({ summary: 'Upsert day note (empty string clears)' })
  updateDay(
    @Req() req: any,
    @Param('yyyymmdd') yyyymmdd: string,
    @Body() body: UpdateDayNoteDto,
  ) {
    return this.journal.upsertDayNote(req.user.id, yyyymmdd, body.note);
  }
}
