import { Module } from '@nestjs/common';
import { MarketDataModule } from '../market-data/market-data.module';
import { RiskModule } from '../risk/risk.module';
import { LlmFilterController } from './llm-filter.controller';
import { LlmFilterService } from './llm-filter.service';
import { ToolExecutor } from './tool-executor';

@Module({
  imports: [MarketDataModule, RiskModule],
  controllers: [LlmFilterController],
  providers: [LlmFilterService, ToolExecutor],
  exports: [LlmFilterService],
})
export class LlmFilterModule {}
