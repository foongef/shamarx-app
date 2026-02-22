import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { MarketDataController } from './market-data.controller';
import { CandleService } from './candle.service';
import { IndicatorService } from './indicator.service';
import { SpreadService } from './spread.service';
import { SRLevelService } from './sr-level.service';
import { EconomicCalendarService } from './economic-calendar.service';

@Module({
  imports: [HttpModule],
  controllers: [MarketDataController],
  providers: [
    CandleService,
    IndicatorService,
    SpreadService,
    SRLevelService,
    EconomicCalendarService,
  ],
  exports: [
    CandleService,
    IndicatorService,
    SpreadService,
    SRLevelService,
    EconomicCalendarService,
  ],
})
export class MarketDataModule {}
