import { Controller, Get, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiOkResponse } from '@nestjs/swagger';
import { CandleService } from './candle.service';
import { IndicatorService } from './indicator.service';
import { SpreadService } from './spread.service';
import { SRLevelService } from './sr-level.service';
import { EconomicCalendarService } from './economic-calendar.service';
import {
  MarketSnapshotDto,
  StructureContextDto,
  SRLevelDto,
  SpreadStatsDto,
  EconomicRiskDto,
} from '@app/common';

@ApiTags('Market Data')
@Controller('api/market-data')
export class MarketDataController {
  private readonly logger = new Logger(MarketDataController.name);

  constructor(
    private readonly candleService: CandleService,
    private readonly indicatorService: IndicatorService,
    private readonly spreadService: SpreadService,
    private readonly srLevelService: SRLevelService,
    private readonly economicCalendarService: EconomicCalendarService,
  ) {}

  @Get('health')
  @ApiOperation({ summary: 'Health check for market data service' })
  health() {
    return { status: 'ok', service: 'market-data' };
  }

  @Get('market-snapshot')
  @ApiOperation({ summary: 'Get current market snapshot with indicators' })
  @ApiOkResponse({ type: MarketSnapshotDto })
  async getMarketSnapshot(): Promise<MarketSnapshotDto> {
    return this.indicatorService.getMarketSnapshot();
  }

  @Get('structure-context')
  @ApiOperation({ summary: 'Get market structure context (bias, swings, BOS)' })
  @ApiOkResponse({ type: StructureContextDto })
  async getStructureContext(): Promise<StructureContextDto> {
    return this.srLevelService.getStructureContext();
  }

  @Get('sr-levels')
  @ApiOperation({ summary: 'Get active support/resistance levels' })
  @ApiOkResponse({ type: [SRLevelDto] })
  async getSRLevels(): Promise<SRLevelDto[]> {
    return this.srLevelService.getActiveLevels();
  }

  @Get('spread-stats')
  @ApiOperation({ summary: 'Get current spread statistics' })
  @ApiOkResponse({ type: SpreadStatsDto })
  async getSpreadStats(): Promise<SpreadStatsDto> {
    return this.spreadService.getSpreadStats();
  }

  @Get('economic-risk')
  @ApiOperation({ summary: 'Get economic calendar risk assessment' })
  @ApiOkResponse({ type: EconomicRiskDto })
  async getEconomicRisk(): Promise<EconomicRiskDto> {
    return this.economicCalendarService.getEconomicRisk();
  }
}
