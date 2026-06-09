import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/prisma';
import { AuthModule } from '../auth/auth.module';
import { AdminUsersController } from './users/admin-users.controller';
import { AdminUsersService } from './users/admin-users.service';
import { AdminSessionsController } from './sessions/admin-sessions.controller';
import { AdminSessionsService } from './sessions/admin-sessions.service';
import { AdminEngineController } from './engine/admin-engine.controller';
import { AdminAnalyticsModule } from './analytics/admin-analytics.module';
import { AdminBacktestController } from './backtest/admin-backtest.controller';
import { AdminBacktestService } from './backtest/admin-backtest.service';

@Module({
  imports: [PrismaModule, AuthModule, AdminAnalyticsModule],
  controllers: [
    AdminUsersController,
    AdminSessionsController,
    AdminEngineController,
    AdminBacktestController,
  ],
  providers: [AdminUsersService, AdminSessionsService, AdminBacktestService],
})
export class AdminModule {}
