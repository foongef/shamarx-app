import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  NotFoundException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiOkResponse, ApiBody, ApiParam } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.service';
import { BacktestService } from './backtest.service';
import { CreateBacktestDto } from './dto/create-backtest.dto';
import { BacktestRunResult, BacktestTradeResult } from './dto/backtest-result.dto';

@UseGuards(JwtAuthGuard)
@ApiTags('Backtest')
@Controller('api/backtest')
export class BacktestController {
  constructor(private readonly backtestService: BacktestService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Create and run a new backtest' })
  @ApiBody({ type: CreateBacktestDto })
  async createBacktest(@Body() dto: CreateBacktestDto, @CurrentUser() me: AuthenticatedUser) {
    const run = await this.backtestService.createAndRun(dto, me.id);
    return { id: run.id, status: run.status };
  }

  @Get()
  @ApiOperation({ summary: 'List recent backtest runs (newest first)' })
  @ApiOkResponse({ type: [BacktestRunResult] })
  async listBacktests(@CurrentUser() me: AuthenticatedUser) {
    return this.backtestService.listRuns(me.id, 50);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get backtest run results by ID' })
  @ApiParam({ name: 'id', description: 'Backtest run ID' })
  @ApiOkResponse({ type: BacktestRunResult })
  async getBacktest(@Param('id') id: string, @CurrentUser() me: AuthenticatedUser) {
    const run = await this.backtestService.getRun(id, me.id);
    if (!run) throw new NotFoundException(`Backtest run ${id} not found`);
    return run;
  }

  @Get(':id/trades')
  @ApiOperation({ summary: 'Get individual trades from a backtest run' })
  @ApiParam({ name: 'id', description: 'Backtest run ID' })
  @ApiOkResponse({ type: [BacktestTradeResult] })
  async getBacktestTrades(@Param('id') id: string, @CurrentUser() me: AuthenticatedUser) {
    const trades = await this.backtestService.getTrades(id, me.id);
    if (!trades) throw new NotFoundException(`Backtest run ${id} not found`);
    return trades;
  }

  @Get(':id/candles')
  @ApiOperation({ summary: 'Get M15 candles for a backtest run time range' })
  @ApiParam({ name: 'id', description: 'Backtest run ID' })
  async getBacktestCandles(@Param('id') id: string, @CurrentUser() me: AuthenticatedUser) {
    const candles = await this.backtestService.getCandles(id, me.id);
    if (!candles) throw new NotFoundException(`Backtest run ${id} not found`);
    return candles;
  }
}
