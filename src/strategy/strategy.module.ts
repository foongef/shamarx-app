import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { MarketDataModule } from '../market-data/market-data.module';
import { RiskModule } from '../risk/risk.module';
import { LlmFilterModule } from '../llm-filter/llm-filter.module';
import { StrategyController } from './strategy.controller';
import { StrategyService } from './strategy.service';
import { PatternDetector } from './pattern-detector';
import { StructureAnalyzer } from './structure-analyzer';

@Module({
  imports: [HttpModule, MarketDataModule, RiskModule, LlmFilterModule],
  controllers: [StrategyController],
  providers: [StrategyService, PatternDetector, StructureAnalyzer],
})
export class StrategyModule {}
