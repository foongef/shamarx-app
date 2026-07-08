/**
 * PendingEntryMonitor — lifecycle for retrace-entry LIMIT orders.
 *
 * Trades are born status=PENDING carrying the broker orderId. Every minute
 * this cron asks the broker what became of each parked limit:
 *   FILLED → promote to OPEN (real fill price + positionId), seed the
 *            position manager's peak at the fill
 *   GONE   → the GTD expiry lapsed unfilled (or the order was cancelled at
 *            the broker) → CANCELLED / exitReason EXPIRED. pnl stays NULL —
 *            an unfilled order never risked a cent.
 *   PENDING→ leave it parked.
 *
 * A broker error on one trade never blocks the rest; an unreachable broker
 * leaves rows PENDING for the next sweep (and the STALE_BROKER daily sweep
 * is the terminal backstop).
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '@app/prisma';
import { BrokerHttpClient } from './broker-http-client';
import { LiveStrategyService } from './live-strategy.service';

@Injectable()
export class PendingEntryMonitorService {
  private readonly logger = new Logger(PendingEntryMonitorService.name);
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly brokerHttp: BrokerHttpClient,
    private readonly liveStrategy: LiveStrategyService,
  ) {}

  @Cron('45 * * * * *') // every minute at :45, offset from bar-boundary crons
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      await this.sweepOnce();
    } catch (err) {
      this.logger.warn(`pending-entry sweep failed: ${(err as Error).message}`);
    } finally {
      this.sweeping = false;
    }
  }

  async sweepOnce(): Promise<{ filled: number; expired: number }> {
    const pending = await this.prisma.trade.findMany({
      where: {
        status: 'PENDING',
        entryType: 'RETRACE_LIMIT',
        brokerOrderId: { not: null },
        accountId: { not: null },
      },
      select: {
        id: true, symbol: true, side: true, accountId: true,
        brokerOrderId: true, limitPrice: true, orderExpiresAt: true,
        managementState: true, statusHistory: true,
      },
      take: 50,
    });
    let filled = 0;
    let expired = 0;

    for (const t of pending) {
      try {
        const st = await this.brokerHttp.fetchOrderStatus(
          t.accountId!, t.brokerOrderId!, t.symbol,
        );
        if (st.status === 'FILLED' && st.positionId) {
          const fillPrice =
            typeof st.executionPrice === 'number' && st.executionPrice > 0
              ? st.executionPrice
              : t.limitPrice!;
          const ms = (t.managementState as any) ?? {};
          await this.prisma.trade.update({
            where: { id: t.id },
            data: {
              status: 'OPEN',
              mt5Ticket: st.positionId,
              entryPrice: fillPrice,
              managementState: { ...ms, peakFavorablePrice: fillPrice },
              statusHistory: [
                ...((t.statusHistory as any[]) ?? []),
                { status: 'OPEN', timestamp: new Date().toISOString(), ticket: st.positionId },
              ],
            },
          });
          filled++;
          this.logger.log(
            `[${t.symbol}] retrace limit FILLED @ ${fillPrice} → position ${st.positionId}`,
          );
          this.liveStrategy.pushExternalEvent({
            ts: new Date().toISOString(), symbol: t.symbol, type: 'limit-filled',
            side: t.side, entryPrice: fillPrice,
          });
        } else if (st.status === 'GONE') {
          await this.prisma.trade.update({
            where: { id: t.id },
            data: {
              status: 'CANCELLED',
              exitReason: 'EXPIRED',
              closedAt: new Date(),
              statusHistory: [
                ...((t.statusHistory as any[]) ?? []),
                { status: 'CANCELLED', timestamp: new Date().toISOString(), reason: 'EXPIRED' },
              ],
            },
          });
          expired++;
          this.logger.log(`[${t.symbol}] retrace limit expired unfilled @ ${t.limitPrice}`);
          this.liveStrategy.pushExternalEvent({
            ts: new Date().toISOString(), symbol: t.symbol, type: 'limit-expired',
            side: t.side, limitPrice: t.limitPrice,
          });
        }
        // PENDING → leave parked
      } catch (err) {
        this.logger.debug(
          `order-status check failed for ${t.symbol} order=${t.brokerOrderId}: ${(err as Error).message}`,
        );
      }
    }
    return { filled, expired };
  }
}
