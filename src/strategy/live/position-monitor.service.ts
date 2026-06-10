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
import { LiveSmcOrchestrator } from './live-smc-orchestrator';
import { JournalService } from '../../journal/journal.service';
import { BrokerAccountsService } from '../../broker-accounts/broker-accounts.service';
import { BrokerHttpClient } from './broker-http-client';

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

/**
 * A trade is only finalized as closed after this many CONSECUTIVE reconcile
 * passes where the broker did not report its ticket. A single empty read is
 * not trustworthy: a freshly-reconnected MetaApi client returns [] with
 * HTTP 200 until its terminal state sync completes. On 2026-06-08 one such
 * read orphaned all 60 open trades at pnl=0 in a single pass.
 */
const ABSENCE_CONFIRMATIONS = 3;

@Injectable()
export class PositionMonitorService implements OnModuleInit {
  private readonly logger = new Logger(PositionMonitorService.name);
  private readonly liveMode: boolean;
  private readonly pairs: string[];
  /** tradeId → consecutive reconcile passes where the broker didn't report the ticket. */
  private readonly absenceCounts = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly httpService: HttpService,
    private readonly config: ConfigService,
    @Inject(forwardRef(() => LiveControlService))
    private readonly liveControl: LiveControlService,
    private readonly orchestrator: LiveSmcOrchestrator,
    private readonly journal: JournalService,
    private readonly brokerAccounts: BrokerAccountsService,
    private readonly brokerHttp: BrokerHttpClient,
  ) {
    this.liveMode = (this.config.get<string>('LIVE_MODE') || 'false').toLowerCase() === 'true';
    const pairsCsv = this.config.get<string>('STRATEGY_PAIRS') || 'XAUUSD,EURUSD,GBPUSD,USDJPY';
    this.pairs = pairsCsv.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  }

  private get fanOutEnabled(): boolean {
    return (this.config.get<string>('ENABLE_MULTI_ACCOUNT_FANOUT') || 'false').toLowerCase() === 'true';
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
    if (this.fanOutEnabled) {
      const accounts = await this.brokerAccounts.findEnabled();
      for (const account of accounts) {
        for (const symbol of this.pairs) {
          try {
            await this.reconcilePairForAccount(symbol, account);
          } catch (err) {
            this.logger.error(`[${(account as any).name}/${symbol}] reconcile error: ${(err as Error).message}`);
          }
        }
      }
    } else {
      for (const symbol of this.pairs) {
        try {
          await this.reconcilePair(symbol);
        } catch (err) {
          this.logger.error(`[${symbol}] reconcile error: ${(err as Error).message}`);
        }
      }
    }

    // Safety net: catch any closed trades that lost their JournalEntry
    // due to a failed Hook 2. Idempotent — only touches rows with no
    // journalEntry yet.
    try {
      const orphans = await this.prisma.trade.findMany({
        where: { status: 'CLOSED', journalEntry: null },
        select: { id: true },
      });
      for (const o of orphans) {
        await this.journal.enrichJournalOnExit(o.id);
      }
      if (orphans.length > 0) {
        this.logger.log(`Journal safety net: enriched ${orphans.length} orphan trade(s)`);
      }
    } catch (err) {
      this.logger.warn(`Journal safety net failed: ${(err as Error).message}`);
    }
  }

  private async reconcilePair(symbol: string): Promise<void> {
    const brokerPositions = await this.fetchBrokerPositions(symbol);
    const brokerTicketSet = new Set(brokerPositions.map((p) => p.ticket));

    const dbOpenTrades = await this.prisma.trade.findMany({
      where: { symbol, status: 'OPEN', mt5Ticket: { not: null } },
    });

    await this.reconcileTrades(symbol, dbOpenTrades, brokerTicketSet);
  }

  /**
   * Per-account version of reconcilePair. Open trades queried with
   * accountId scope; broker calls routed via BrokerHttpClient.
   *
   * NOTE: fetchOpenPositions throwing is SAFE here — the exception
   * propagates to reconcileAll's per-pair catch and this pass is skipped
   * without touching absence counters. The dangerous case is a successful
   * response with missing tickets, which the confirmation counter absorbs.
   */
  private async reconcilePairForAccount(symbol: string, account: { id: string }): Promise<void> {
    const brokerPositions = await this.brokerHttp.fetchOpenPositions(account.id, symbol);
    const brokerTicketSet = new Set(brokerPositions.map((p) => p.ticket));

    const dbOpenTrades = await this.prisma.trade.findMany({
      where: { symbol, status: 'OPEN', mt5Ticket: { not: null }, accountId: account.id },
    });

    await this.reconcileTrades(symbol, dbOpenTrades, brokerTicketSet);
  }

  /**
   * Shared absence-tracking core. A ticket missing from the broker's
   * position list is only finalized after ABSENCE_CONFIRMATIONS consecutive
   * misses; any sighting resets the counter. This converts "one bad read
   * nukes the books" into "a real close finalizes ~3 M15 cycles late",
   * which the journal back-fills with accurate history anyway.
   */
  private async reconcileTrades(
    symbol: string,
    dbOpenTrades: Array<{
      id: string;
      mt5Ticket: number | null;
      side: string;
      lotSize: number;
      entryPrice: number;
      slPrice: number;
      tpPrice: number;
    }>,
    brokerTicketSet: Set<number>,
  ): Promise<void> {
    for (const trade of dbOpenTrades) {
      if (trade.mt5Ticket && brokerTicketSet.has(trade.mt5Ticket)) {
        // Still open at broker — leave alone (broker manages SL/TP).
        this.absenceCounts.delete(trade.id);
        continue;
      }

      const misses = (this.absenceCounts.get(trade.id) ?? 0) + 1;
      if (misses < ABSENCE_CONFIRMATIONS) {
        this.absenceCounts.set(trade.id, misses);
        this.logger.warn(
          `[${symbol}] ticket=${trade.mt5Ticket} missing from broker ` +
            `(${misses}/${ABSENCE_CONFIRMATIONS} confirmations) — holding off`,
        );
        continue;
      }

      this.absenceCounts.delete(trade.id);
      await this.finalizeClosedTrade(
        trade.id,
        trade.mt5Ticket!,
        symbol,
        trade.side as 'BUY' | 'SELL',
        trade.lotSize,
        trade.entryPrice,
        trade.slPrice,
        trade.tpPrice,
      );
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

      this.journal.enrichJournalOnExit(tradeId).catch((err) =>
        this.logger.warn(`enrichJournalOnExit failed for ${tradeId}: ${(err as Error).message}`),
      );

      await this.redis.publish(REDIS_CHANNELS.TRADE_CLOSED, {
        tradeId,
        ticket,
        symbol,
        side,
        exitReason,
        pnl,
      });

      // Tell the orchestrator about the exit so per-pair cooldown + RiskManager
      // gates apply for the next M15 evaluation. PnL drives the consecutive-
      // losses / daily-loss counters that pause trading during slumps.
      // Mirrors V6-alt's smc-engine.ts:114-116.
      const normalized: 'SL' | 'TP' | 'OTHER' =
        exitReason.startsWith('SL') ? 'SL'
        : exitReason.startsWith('TP') ? 'TP'
        : 'OTHER';
      this.orchestrator.recordExit(symbol, normalized, closedAt.toISOString(), pnl ?? undefined);

      this.logger.log(`[${symbol}] CLOSED ticket=${ticket} reason=${exitReason} pnl=$${pnl} closePrice=${closePrice}`);

      // Cross-leg signaling: when a TP1 leg closes at TP, the sister Runner
      // earned the right to be a "free trade" — move its broker SL to BE so
      // worst-case is zero on the Runner. Without this, a Runner that peaks
      // below the 1.5R RUNNER-trail BE threshold (trail-config.ts:25) reverses
      // back to the original SL — turning a partial-profit ladder into a net
      // loss. The position-simulator already gives each leg independent
      // trail management (position-simulator.ts:18), but it never modeled
      // a TP1→Runner signal.
      if (normalized === 'TP') {
        await this.maybeTriggerSisterRunnerBe(tradeId).catch((err) =>
          this.logger.warn(
            `[${symbol}] sister Runner BE trigger failed for ${tradeId}: ${(err as Error).message}`,
          ),
        );
      }
    } catch (err) {
      this.logger.error(`finalize tradeId=${tradeId} failed: ${(err as Error).message}`);
    }
  }

  /**
   * If a TP1 leg just closed at TP, find its sister Runner (same symbol+side+
   * entryPrice, opened within ±5s) and activate break-even on it: move broker
   * SL to entry ± 10% of original risk (matches position-simulator.ts:52,77
   * buffer), update DB managementState.breakevenActivated=true.
   *
   * Idempotent — skipped if sister already has breakevenActivated=true (e.g.
   * the M15 position manager already moved it past BE via its own trail).
   * Fire-and-forget at call site; failures logged not thrown.
   */
  private async maybeTriggerSisterRunnerBe(closedTradeId: string): Promise<void> {
    const closed = await this.prisma.trade.findUnique({ where: { id: closedTradeId } });
    if (!closed) return;
    const closedMgmt = (closed.managementState ?? {}) as { trailKey?: 'TP1' | 'RUNNER' };
    if (closedMgmt.trailKey !== 'TP1') return;

    const lower = new Date(closed.createdAt.getTime() - 5_000);
    const upper = new Date(closed.createdAt.getTime() + 5_000);
    const sister = await this.prisma.trade.findFirst({
      where: {
        symbol: closed.symbol,
        side: closed.side,
        entryPrice: closed.entryPrice,
        status: 'OPEN',
        mt5Ticket: { not: null },
        id: { not: closed.id },
        accountId: (closed as any).accountId,
        createdAt: { gte: lower, lte: upper },
      },
    });
    if (!sister) return;

    const sisterMgmt = (sister.managementState ?? {}) as {
      trailKey?: 'TP1' | 'RUNNER';
      originalSlPrice?: number;
      breakevenActivated?: boolean;
      peakFavorablePrice?: number;
    };
    if (sisterMgmt.trailKey !== 'RUNNER') return;
    if (sisterMgmt.breakevenActivated === true) return;

    const originalSl = sisterMgmt.originalSlPrice ?? sister.slPrice;
    const risk = Math.abs(sister.entryPrice - originalSl);
    const buffer = risk * 0.1;
    const newSl = sister.side === 'BUY'
      ? sister.entryPrice + buffer
      : sister.entryPrice - buffer;

    try {
      const sisterAcctId = (sister as any).accountId as string | null | undefined;
      if (sisterAcctId) {
        await this.brokerHttp.modify(sisterAcctId, sister.mt5Ticket!, newSl, sister.tpPrice ?? 0);
      } else {
        // Legacy fallback: trade has no accountId (pre-backfill).
        await firstValueFrom(
          this.httpService.post(
            `${SERVICE_URLS.EXECUTION}/positions/${sister.mt5Ticket}/modify`,
            { slPrice: newSl, tpPrice: sister.tpPrice ?? 0 },
          ),
        );
      }
    } catch (err) {
      this.logger.warn(
        `[${sister.symbol}] sister BE broker modify failed for ticket=${sister.mt5Ticket}: ${(err as Error).message}`,
      );
      return;
    }

    await this.prisma.trade.update({
      where: { id: sister.id },
      data: {
        slPrice: newSl,
        managementState: {
          ...sisterMgmt,
          breakevenActivated: true,
        } as any,
      },
    });
    this.logger.log(
      `[${sister.symbol}] sister Runner BE activated — ticket=${sister.mt5Ticket} SL ${sister.slPrice.toFixed(5)}→${newSl.toFixed(5)} (TP1 ticket=${closed.mt5Ticket} closed at ${closed.exitReason})`,
    );
  }
}
