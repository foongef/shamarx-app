import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiOkResponse, ApiBody, ApiParam } from '@nestjs/swagger';
import { LiveReplayService } from './live-replay.service';
import { StartReplayDto } from './dto/start-replay.dto';

@ApiTags('Live Replay')
@Controller('api/live-replay')
export class LiveReplayController {
  constructor(private readonly service: LiveReplayService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Run a multi-pair, single-account replay using the live SMC evaluator',
  })
  @ApiBody({ type: StartReplayDto })
  async start(@Body() dto: StartReplayDto) {
    return this.service.createAndRun(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List recent replay sessions (newest first)' })
  async list() {
    return this.service.listSessions(50);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a replay session by ID' })
  @ApiParam({ name: 'id' })
  async getOne(@Param('id') id: string) {
    const session = await this.service.getSession(id);
    if (!session) throw new NotFoundException(`Replay session ${id} not found`);
    return session;
  }

  @Get(':id/trades')
  @ApiOperation({ summary: 'Get trades from a replay session' })
  @ApiParam({ name: 'id' })
  async getTrades(@Param('id') id: string) {
    const session = await this.service.getSession(id);
    if (!session) throw new NotFoundException(`Replay session ${id} not found`);
    return this.service.getTrades(id);
  }

  @Get(':id/chart-candles')
  @ApiOperation({
    summary:
      'M15 candles for the SMC annotated chart — ~50 bars centered on the given trade time',
  })
  @ApiParam({ name: 'id' })
  async chartCandles(
    @Param('id') id: string,
    @Query('symbol') symbol: string,
    @Query('time') time: string,
    @Query('window') window?: string,
  ) {
    const session = await this.service.getSession(id);
    if (!session) throw new NotFoundException(`Replay session ${id} not found`);
    const bars = window ? Math.max(20, Math.min(200, parseInt(window, 10))) : 50;
    return this.service.getChartCandles(symbol, time, bars);
  }
}
