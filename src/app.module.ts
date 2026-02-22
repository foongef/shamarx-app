import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '@app/prisma';
import { RedisModule } from '@app/redis';
import { MarketDataModule } from './market-data/market-data.module';
import { StrategyModule } from './strategy/strategy.module';
import { RiskModule } from './risk/risk.module';
import { LlmFilterModule } from './llm-filter/llm-filter.module';
import { JournalModule } from './journal/journal.module';
import { BacktestModule } from './backtest/backtest.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    RedisModule,
    MarketDataModule,
    StrategyModule,
    RiskModule,
    LlmFilterModule,
    JournalModule,
    BacktestModule,
  ],
})
export class AppModule {}
