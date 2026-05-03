import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiOkResponse, ApiBody, ApiParam } from '@nestjs/swagger';
import { BacktestService } from './backtest.service';
import { CreateBacktestDto } from './dto/create-backtest.dto';
import { BacktestRunResult, BacktestTradeResult } from './dto/backtest-result.dto';

@ApiTags('Backtest')
@Controller('api/backtest')
export class BacktestController {
  constructor(private readonly backtestService: BacktestService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Create and run a new backtest' })
  @ApiBody({ type: CreateBacktestDto })
  async createBacktest(@Body() dto: CreateBacktestDto) {
    const run = await this.backtestService.createAndRun(dto);
    return { id: run.id, status: run.status };
  }

  @Get()
  @ApiOperation({ summary: 'List recent backtest runs (newest first)' })
  @ApiOkResponse({ type: [BacktestRunResult] })
  async listBacktests() {
    return this.backtestService.listRuns(50);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get backtest run results by ID' })
  @ApiParam({ name: 'id', description: 'Backtest run ID' })
  @ApiOkResponse({ type: BacktestRunResult })
  async getBacktest(@Param('id') id: string) {
    const run = await this.backtestService.getRun(id);
    if (!run) throw new NotFoundException(`Backtest run ${id} not found`);
    return run;
  }

  @Get(':id/trades')
  @ApiOperation({ summary: 'Get individual trades from a backtest run' })
  @ApiParam({ name: 'id', description: 'Backtest run ID' })
  @ApiOkResponse({ type: [BacktestTradeResult] })
  async getBacktestTrades(@Param('id') id: string) {
    const trades = await this.backtestService.getTrades(id);
    if (!trades) throw new NotFoundException(`Backtest run ${id} not found`);
    return trades;
  }

  @Get(':id/candles')
  @ApiOperation({ summary: 'Get M15 candles for a backtest run time range' })
  @ApiParam({ name: 'id', description: 'Backtest run ID' })
  async getBacktestCandles(@Param('id') id: string) {
    const candles = await this.backtestService.getCandles(id);
    if (!candles) throw new NotFoundException(`Backtest run ${id} not found`);
    return candles;
  }
}
