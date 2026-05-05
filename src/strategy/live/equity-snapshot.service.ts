/**
 * Periodic equity snapshot writer — runs every minute when the live engine
 * is running. Powers the equity-curve chart and daily/weekly P&L reports.
 *
 * Stores: balance, equity (= balance + unrealized P&L), margin, freeMargin,
 * openPositions, mode. One row per minute = ~525,600 rows/year, manageable.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '@app/prisma';
import { SERVICE_URLS } from '@app/common';
import { LiveControlService } from './live-control.service';

@Injectable()
export class EquitySnapshotService implements OnModuleInit {
  private readonly logger = new Logger(EquitySnapshotService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpService: HttpService,
    private readonly control: LiveControlService,
  ) {}

  async onModuleInit() {
    if (this.control.isEnabled()) {
      this.logger.log('Equity snapshot cron armed (every 1 min while running)');
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async takeSnapshot(): Promise<void> {
    if (!this.control.isRunning()) return;
    try {
      const accountRes = await firstValueFrom(
        this.httpService.get(`${SERVICE_URLS.EXECUTION}/account`),
      );
      const a = accountRes.data;

      // Skip bogus zero readings — these come from the execution-service
      // graceful-fallback when the broker is unreachable (returns
      // {balance:0, equity:0,...} instead of throwing). Recording them
      // would pollute the equity arc with phantom $0 dips.
      const balance = a?.balance ?? 0;
      const equity = a?.equity ?? 0;
      if (balance <= 0 && equity <= 0) {
        this.logger.debug(
          'Skipping snapshot — broker returned zero account (likely transient error)',
        );
        return;
      }

      const positionsRes = await firstValueFrom(
        this.httpService.get(`${SERVICE_URLS.EXECUTION}/positions`),
      );
      const positions: Array<{ pnl: number }> = positionsRes.data || [];
      const unrealizedPnl = positions.reduce((s, p) => s + (p.pnl || 0), 0);

      const cfg = this.control.getConfig();
      const mode = cfg?.mode ?? 'mock';

      await this.prisma.equitySnapshot.create({
        data: {
          source: 'live',
          mode,
          balance,
          equity,
          unrealizedPnl: Math.round(unrealizedPnl * 100) / 100,
          margin: a.margin ?? 0,
          freeMargin: a.freeMargin ?? 0,
          openPositions: a.openPositions ?? positions.length,
        },
      });
    } catch (err) {
      this.logger.warn(`Snapshot failed: ${(err as Error).message}`);
    }
  }
}
