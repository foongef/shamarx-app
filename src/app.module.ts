import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '@app/prisma';
import { RedisModule } from '@app/redis';
import { CoreModule } from './core/core.module';
import { MarketDataModule } from './market-data/market-data.module';
import { StrategyModule } from './strategy/strategy.module';
import { RiskModule } from './risk/risk.module';
import { LlmFilterModule } from './llm-filter/llm-filter.module';
import { JournalModule } from './journal/journal.module';
import { BacktestModule } from './backtest/backtest.module';
import { LiveReplayModule } from './backtest/live-replay/live-replay.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { BrokerAccountsModule } from './broker-accounts/broker-accounts.module';
import { Mt5HostModule } from './mt5-hosts/mt5-host.module';
import { InviteModule } from './invites/invite.module';
import { MeModule } from './me/me.module';
import { AdminModule } from './admin/admin.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    CoreModule,
    PrismaModule,
    RedisModule,
    UsersModule,
    AuthModule,
    BrokerAccountsModule,
    Mt5HostModule,
    InviteModule,
    MeModule,
    MarketDataModule,
    StrategyModule,
    RiskModule,
    LlmFilterModule,
    JournalModule,
    BacktestModule,
    LiveReplayModule,
    AdminModule,
  ],
})
export class AppModule {}
