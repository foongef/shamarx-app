import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../../auth/guards/roles.guard';
import { AdminAnalyticsService } from './admin-analytics.service';
import { LiveAnalyticsService } from '../../strategy/live/live-analytics.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPERADMIN')
@Controller('api/admin/analytics')
export class AdminAnalyticsController {
  constructor(
    private readonly svc: AdminAnalyticsService,
    private readonly live: LiveAnalyticsService,
  ) {}

  @Get('aggregate')
  aggregate() {
    return this.svc.aggregate();
  }

  @Get('users')
  users() {
    return this.svc.listUsers();
  }

  @Get('trends')
  async trends() {
    const flags = await this.svc.computeFlags();
    const trendData = await this.svc.computeTrends();
    const strategyStatus = this.svc.computeStatus(flags, trendData);
    return { flags, trends: trendData.trends, strategyStatus };
  }

  @Get('users/:id/snapshot')
  userSnapshot(@Param('id') id: string) {
    return this.live.snapshot(id);
  }
}
