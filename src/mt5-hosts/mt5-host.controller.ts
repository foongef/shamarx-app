import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Public } from '../auth/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../auth/guards/roles.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { InternalIpGuard } from '../broker-accounts/oauth/guards/internal-ip.guard';
import { RedisService } from '@app/redis';
import { Mt5HostService } from './mt5-host.service';

@Controller()
export class Mt5HostController {
  constructor(
    private readonly hosts: Mt5HostService,
    private readonly redis: RedisService,
  ) {}

  @Get('api/admin/mt5-hosts')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('SUPERADMIN')
  capacities() {
    return this.hosts.capacities();
  }

  /**
   * Watchdog heartbeats from mt5 hosts. Internal-only (same guard as the
   * oauth-tokens internal route); written to Redis with 300s TTL so the
   * loop-health pill surfaces dead terminals.
   */
  @Post('api/internal/mt5-heartbeat')
  @Public()
  @UseGuards(InternalIpGuard)
  async heartbeat(@Body() b: { hostId: string; accountId: string; state: string }) {
    await this.redis.set(`live:mt5host:${b.hostId}:${b.accountId}`, b.state, 300);
    return { ok: true };
  }
}
