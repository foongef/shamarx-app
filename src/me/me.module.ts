import { Module } from '@nestjs/common';
import { MeController } from './me.controller';
import { PrismaModule } from '@app/prisma';
import { AuthModule } from '../auth/auth.module';
import { MeAnalyticsModule } from './analytics/me-analytics.module';

@Module({
  imports: [PrismaModule, AuthModule, MeAnalyticsModule],
  controllers: [MeController],
})
export class MeModule {}
