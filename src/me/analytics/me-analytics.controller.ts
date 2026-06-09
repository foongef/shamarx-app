import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/auth.service';
import { LiveAnalyticsService } from '../../strategy/live/live-analytics.service';

@UseGuards(JwtAuthGuard)
@Controller('api/me/analytics')
export class MeAnalyticsController {
  constructor(private readonly analytics: LiveAnalyticsService) {}

  @Get('snapshot')
  snapshot(@CurrentUser() me: AuthenticatedUser) {
    return this.analytics.snapshot(me.id);
  }

  @Get('equity-curve')
  equityCurve(@CurrentUser() me: AuthenticatedUser, @Query('days') daysStr?: string) {
    const days = daysStr ? Math.max(1, Math.min(365, parseInt(daysStr, 10))) : 90;
    return this.analytics.equityCurve({ userId: me.id, days });
  }

  @Get('risk-used')
  riskUsed(@CurrentUser() me: AuthenticatedUser) {
    return this.analytics.riskUsedToday(me.id);
  }
}
