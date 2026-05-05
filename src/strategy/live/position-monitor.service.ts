/**
 * Position monitor — reconciles broker-reported positions with our DB after
 * each M15 candle close.
 *
 * Phase 1 keeps SL/TP broker-managed (no trailing). The broker auto-closes at
 * SL or TP. Our job is to detect when an OPEN trade in the DB is no longer
 * present in the broker's position list, fetch the close info, and finalize
 * the trade record.
 */
import { Injectable, Logger, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '@app/prisma';
import { RedisService, REDIS_CHANNELS } from '@app/redis';
import { Timeframe, SERVICE_URLS } from '@app/common';
import { LiveControlService } from './live-control.service';

interface BrokerPosition {
  ticket: number;
  symbol: string;
  side: string;
  lotSize: number;
  entryPrice: number;
  currentPrice: number;
  sl: number;
  tp: number;
  pnl: number;
  openTime: string;
}

@Injectable()
export class PositionMonitorService implements OnModuleInit {
  private readonly logger = new Logger(PositionMonitorService.name);
  private readonly liveMode: boolean;
  private readonly pairs: string[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly httpService: HttpService,
    private readonly config: ConfigService,
    @Inject(forwardRef(() => LiveControlService))
    private readonly liveControl: LiveControlService,
  ) {
    this.liveMode = (this.config.get<string>('LIVE_MODE') || 'false').toLowerCase() === 'true';
    const pairsCsv = this.config.get<string>('STRATEGY_PAIRS') || 'XAUUSD,EURUSD,GBPUSD,USDJPY';
    this.pairs = pairsCsv.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  }

  async onModuleInit() {
    if (!this.liveMode) {
      this.logger.log('LIVE_MODE=false — position monitor DORMANT');
      return;
    }
    this.logger.log(`Position monitor active for ${this.pairs.join(', ')}`);
    await this.redis.subscribe(REDIS_CHANNELS.CANDLE_STORED, (message) => {
      try {
        const data = JSON.parse(message);
        if (data.timeframe !== Timeframe.M15) return;
        if (!this.liveControl.isRunning()) return;
        this.reconcileAll().catch((err) =>
          this.logger.error(`Reconcile failed: ${err.message}`, err.stack),
        );
      } catch {
        // ignore bad payloads
      }
    });
  }

  /** Public entrypoint — useful for manual reconciliation triggers */
  async reconcileAll(): Promise<void> {
    for (const symbol of this.pairs) {
      try {
        await this.reconcilePair(symbol);
      } catch (err) {
        this.logger.error(`[${symbol}] reconcile error: ${(err as Error).message}`);
      }
    }
  }

  private async reconcilePair(symbol: string): Promise<void> {
    const brokerPositions = await this.fetchBrokerPositions(symbol);
    const brokerTicketSet = new Set(brokerPositions.map((p) => p.ticket));

    const dbOpenTrades = await this.prisma.trade.findMany({
      where: { symbol, status: 'OPEN', mt5Ticket: { not: null } },
    });

    for (const trade of dbOpenTrades) {
      if (trade.mt5Ticket && brokerTicketSet.has(trade.mt5Ticket)) {
        // Still open at broker — leave alone (broker manages SL/TP).
        continue;
      }
      // Position no longer at broker → it was closed (SL, TP, or manual).
      await this.finalizeClosedTrade(trade.id, trade.mt5Ticket!, symbol, trade.side as 'BUY' | 'SELL', trade.lotSize, trade.entryPrice, trade.slPrice, trade.tpPrice);
    }
  }

  private async fetchBrokerPositions(symbol: string): Promise<BrokerPosition[]> {
    const url = `${SERVICE_URLS.EXECUTION}/positions`;
    const res = await firstValueFrom(this.httpService.get(url, { params: { symbol } }));
    return res.data || [];
  }

  private async finalizeClosedTrade(
    tradeId: string,
    ticket: number,
    symbol: string,
    side: 'BUY' | 'SELL',
    lotSize: number,
    entryPrice: number,
    slPrice: number,
    tpPrice: number,
  ): Promise<void> {
    try {
      // 1. Try to fetch the REAL close info from broker history (MetaApi deals
      //    or mock close-history). This gives accurate close price + realized
      //    P&L (including commission and swap on metaapi).
      let closePrice: number | null = null;
      let pnl: number | null = null;
      let exitReason: string = 'CLOSED';
      let closedAt: Date = new Date();

      try {
        const histRes = await firstValueFrom(
          this.httpService.get(`${SERVICE_URLS.EXECUTION}/positions/${ticket}/history`),
        );
        const h = histRes.data;
        if (h && typeof h === 'object') {
          if (typeof h.closePrice === 'number') closePrice = h.closePrice;
          if (typeof h.realizedPnl === 'number') pnl = h.realizedPnl;
          if (h.exitReason) exitReason = String(h.exitReason);
          if (h.closeTime) {
            const t = new Date(h.closeTime);
            if (!isNaN(t.getTime())) closedAt = t;
          }
        }
      } catch (err) {
        this.logger.debug(`history fetch for ${ticket} failed: ${(err as Error).message}`);
      }

      // 2. If broker history wasn't available (e.g. close still propagating),
      //    fall back to a midpoint heuristic so the row doesn't stay OPEN.
      //    Mark as estimated so the UI / future re-reconcile can replace it.
      if (closePrice === null || pnl === null) {
        const midGuess = (slPrice + tpPrice) / 2;
        closePrice = closePrice ?? midGuess;
        const guessReason: 'SL' | 'TP' =
          side === 'BUY'
            ? (closePrice >= entryPrice ? 'TP' : 'SL')
            : (closePrice <= entryPrice ? 'TP' : 'SL');
        if (exitReason === 'CLOSED') exitReason = `${guessReason}_EST`;
        const priceDiff = side === 'BUY' ? closePrice - entryPrice : entryPrice - closePrice;
        const lotUnits = symbol === 'XAUUSD' ? 100 : 100_000;
        let rawPnl = priceDiff * lotSize * lotUnits;
        if (symbol.endsWith('JPY')) rawPnl /= closePrice;
        pnl = Math.round(rawPnl * 100) / 100;
      }

      await this.prisma.trade.update({
        where: { id: tradeId },
        data: {
          status: 'CLOSED',
          closePrice: Math.round((closePrice ?? 0) * 1e5) / 1e5,
          pnl: Math.round((pnl ?? 0) * 100) / 100,
          exitReason,
          closedAt,
        },
      });

      await this.redis.publish(REDIS_CHANNELS.TRADE_CLOSED, {
        tradeId,
        ticket,
        symbol,
        side,
        exitReason,
        pnl,
      });

      this.logger.log(`[${symbol}] CLOSED ticket=${ticket} reason=${exitReason} pnl=$${pnl} closePrice=${closePrice}`);
    } catch (err) {
      this.logger.error(`finalize tradeId=${tradeId} failed: ${(err as Error).message}`);
    }
  }
}
