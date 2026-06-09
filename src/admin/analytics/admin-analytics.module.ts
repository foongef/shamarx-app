import { Module } from '@nestjs/common';
import { AdminAnalyticsController } from './admin-analytics.controller';
import { AdminAnalyticsService } from './admin-analytics.service';
import { PrismaModule } from '@app/prisma';
import { StrategyModule } from '../../strategy/strategy.module';

@Module({
  imports: [PrismaModule, StrategyModule],
  controllers: [AdminAnalyticsController],
  providers: [AdminAnalyticsService],
})
export class AdminAnalyticsModule {}
