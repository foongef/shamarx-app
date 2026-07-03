/**
 * ExitReconciliationService — replaces ESTIMATED trade exits with broker truth.
 *
 * When a position disappears from the broker before its closing deal is
 * queryable, position-monitor finalizes the Trade with a midpoint-guess
 * close price and a `TP_EST` / `SL_EST` exit reason. Those estimates corrupt
 * P&L attribution and every stat built on it.
 *
 * This cron re-polls broker history for recently-closed estimated trades and
 * overwrites the guess with the real close price / P&L / reason once the
 * broker registers the deal. Account-scoped trades go through
 * BrokerHttpClient (correct broker per account, incl. cTrader deal history);
 * legacy rows fall back to the global endpoint.
 *
 * NOTE: orchestrator cooldowns / RiskManager already consumed the estimated
 * exit when the trade was finalized — this service corrects the RECORD, it
 * deliberately does not re-fire recordExit (double-counting would be worse
 * than a slightly-off risk counter).
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '@app/prisma';
import { SERVICE_URLS } from '@app/common';
import { BrokerHttpClient } from './broker-http-client';

const LOOKBACK_HOURS = 72;

interface BrokerCloseInfo {
  closePrice: number;
  pnl: number;
  reason: string;
  closedAt: Date | null;
}

@Injectable()
export class ExitReconciliationService {
  private readonly logger = new Logger(ExitReconciliationService.name);
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly brokerHttp: BrokerHttpClient,
    private readonly httpService: HttpService,
  ) {}

  @Cron('30 */5 * * * *') // every 5 min, offset from the minute-boundary crons
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      await this.sweepOnce();
    } finally {
      this.sweeping = false;
    }
  }

  async sweepOnce(): Promise<number> {
    const since = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000);
    const estimated = await this.prisma.trade.findMany({
      where: {
        status: 'CLOSED',
        exitReason: { in: ['TP_EST', 'SL_EST'] },
        closedAt: { gte: since },
        mt5Ticket: { not: null },
      },
      select: {
        id: true, mt5Ticket: true, symbol: true, exitReason: true,
        accountId: true, pnl: true,
      },
      take: 50,
    });
    if (estimated.length === 0) return 0;

    let fixed = 0;
    for (const t of estimated) {
      try {
        const info = await this.fetchCloseInfo(t.accountId, t.mt5Ticket!);
        if (!info) continue; // broker still hasn't registered the close — retry next sweep
        await this.prisma.trade.update({
          where: { id: t.id },
          data: {
            closePrice: Math.round(info.closePrice * 1e5) / 1e5,
            pnl: Math.round(info.pnl * 100) / 100,
            exitReason: info.reason,
            ...(info.closedAt ? { closedAt: info.closedAt } : {}),
          },
        });
        fixed++;
        this.logger.log(
          `[${t.symbol}] reconciled ticket=${t.mt5Ticket}: ${t.exitReason} pnl=$${t.pnl} → ` +
            `${info.reason} pnl=$${info.pnl.toFixed(2)} @ ${info.closePrice}`,
        );
      } catch (err) {
        this.logger.debug(
          `reconcile ticket=${t.mt5Ticket} failed: ${(err as Error).message}`,
        );
      }
    }
    return fixed;
  }

  /**
   * Broker history via the trade's own account when stamped (fan-out world),
   * else the legacy global endpoint. Accepts BOTH response shapes:
   * MetaApi returns {closePrice, realizedPnl, exitReason, closeTime};
   * the account-scoped route returns {closePrice, pnl, reason, closeTime}.
   */
  private async fetchCloseInfo(
    accountId: string | null,
    ticket: number,
  ): Promise<BrokerCloseInfo | null> {
    let h: any = null;
    if (accountId) {
      h = await this.brokerHttp.fetchPositionHistory(accountId, ticket).catch(() => null);
    }
    if (!h) {
      const res = await firstValueFrom(
        this.httpService.get(`${SERVICE_URLS.EXECUTION}/positions/${ticket}/history`),
      ).catch(() => null);
      h = res?.data ?? null;
    }
    if (!h || typeof h !== 'object') return null;

    const closePrice = typeof h.closePrice === 'number' ? h.closePrice : null;
    const pnl =
      typeof h.realizedPnl === 'number' ? h.realizedPnl
      : typeof h.pnl === 'number' ? h.pnl
      : null;
    const reasonRaw = h.exitReason ?? h.reason ?? null;
    if (closePrice === null || pnl === null) return null;

    // Normalize broker close reasons to our exit enum; keep the broker's
    // word when it already matches, never write back another *_EST.
    const reason = String(reasonRaw ?? '').toUpperCase();
    const normalized =
      reason.includes('TP') || reason.includes('TAKE') ? 'TP'
      : reason.includes('SL') || reason.includes('STOP') ? 'SL'
      : 'CLOSED';

    let closedAt: Date | null = null;
    if (h.closeTime) {
      const raw = h.closeTime;
      // cTrader deal history returns epoch-ms as a string; MetaApi returns ISO.
      const t = /^\d+$/.test(String(raw)) ? new Date(Number(raw)) : new Date(raw);
      if (!isNaN(t.getTime()) && t.getTime() > 0) closedAt = t;
    }
    return { closePrice, pnl, reason: normalized, closedAt };
  }
}
