import { Module } from '@nestjs/common';
import { MeAnalyticsController } from './me-analytics.controller';
import { StrategyModule } from '../../strategy/strategy.module';

@Module({
  imports: [StrategyModule],
  controllers: [MeAnalyticsController],
})
export class MeAnalyticsModule {}
