/**
 * Periodic equity snapshot writer — runs every minute when the live engine
 * is running. Powers the equity-curve chart and daily/weekly P&L reports.
 *
 * Stores one row per enabled BrokerAccount per minute (since Spec 1's
 * multi-account refactor). Per-account isolation is preserved so the
 * analytics layer can scope by `account.userId`.
 *
 * Before this revision the cron wrote a single global snapshot with
 * `accountId = NULL`; that hid the latest equity from any query that
 * joined through BrokerAccount (notably Spec 2.5 analytics).
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '@app/prisma';
import { LiveControlService } from './live-control.service';
import { BrokerHttpClient } from './broker-http-client';

@Injectable()
export class EquitySnapshotService implements OnModuleInit {
  private readonly logger = new Logger(EquitySnapshotService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly control: LiveControlService,
    private readonly broker: BrokerHttpClient,
  ) {}

  async onModuleInit() {
    if (this.control.isEnabled()) {
      this.logger.log('Equity snapshot cron armed (every 1 min while running, per enabled account)');
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async takeSnapshot(): Promise<void> {
    if (!this.control.isRunning()) return;

    const accounts = await this.prisma.brokerAccount.findMany({
      where: { isEnabled: true },
      select: { id: true, name: true },
    });
    if (accounts.length === 0) {
      this.logger.debug('No enabled BrokerAccounts — skipping snapshot');
      return;
    }

    const cfg = this.control.getConfig();
    const mode = cfg?.mode ?? 'mock';

    // Per-account failure isolation — one bad broker doesn't block the others.
    await Promise.all(
      accounts.map((account) => this.snapshotAccount(account.id, account.name, mode)),
    );
  }

  private async snapshotAccount(accountId: string, name: string, mode: string): Promise<void> {
    try {
      const a = await this.broker.fetchAccount(accountId);

      // Skip bogus zero readings — execution-service returns
      // {balance:0, equity:0,...} on transient broker disconnect.
      const balance = a?.balance ?? 0;
      const equity = a?.equity ?? 0;
      if (balance <= 0 && equity <= 0) {
        this.logger.debug(`[${name}] Skipping snapshot — broker returned zero account`);
        return;
      }

      const positions = await this.broker.fetchOpenPositions(accountId);
      const unrealizedPnl = positions.reduce((s, p) => s + (p.pnl ?? 0), 0);

      await this.prisma.equitySnapshot.create({
        data: {
          accountId,
          source: 'live',
          mode,
          balance,
          equity,
          unrealizedPnl: Math.round(unrealizedPnl * 100) / 100,
          margin: a.margin ?? 0,
          freeMargin: a.freeMargin ?? 0,
          openPositions: positions.length,
        },
      });
    } catch (err) {
      this.logger.warn(`[${name}] Snapshot failed: ${(err as Error).message}`);
    }
  }
}
