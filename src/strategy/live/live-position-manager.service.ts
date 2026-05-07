/**
 * LivePositionManager — runs after each M15 close to apply V6-alt's
 * breakeven / trailing-stop logic to open broker positions.
 *
 * Why this exists: V6-alt's profitability depends heavily on
 * `updatePositionManagement` — moving SL to breakeven once price travels
 * far enough, then trailing the SL to lock in profit. Without this, every
 * loser realizes the full -1R and runners that travel +0.5R then reverse
 * become full SL hits instead of breakeven exits.
 *
 * State lives in two places:
 *   - Broker: actual SL/TP on the open position (source of truth for
 *     fills; broker auto-closes when hit)
 *   - DB Trade.managementState: our cached `breakevenActivated`,
 *     `peakFavorablePrice`, `originalSlPrice`, `trailKey` (TP1|RUNNER)
 *     used to drive `updatePositionManagement`. Persisted so a container
 *     restart doesn't lose breakeven flags.
 *
 * Flow on each CANDLE_STORED (M15):
 *   1. Fetch broker open positions for each pair.
 *   2. Fetch the latest closed M15 candle for the pair (the one that just
 *      triggered this event).
 *   3. For each open position, load managementState from DB, build a
 *      V6-alt-compatible SimulatedPosition, run `updatePositionManagement`,
 *      and write back the result.
 *   4. If SL or TP changed materially, call execution-service
 *      `/positions/{ticket}/modify` to update the broker.
 */
import { Injectable, Logger, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '@app/prisma';
import { RedisService, REDIS_CHANNELS } from '@app/redis';
import { Timeframe, SERVICE_URLS } from '@app/common';
import { LiveControlService } from './live-control.service';
import {
  BacktestCandle,
  RegimeTradeParams,
  SimulatedPosition,
} from '../../backtest/engine/types';
import { updatePositionManagement } from '../../backtest/engine/position-simulator';
import { getSpread } from '../../backtest/engine/spread-model';
import {
  SMC_TP1_TRAIL,
  SMC_RUNNER_TRAIL,
} from '../../backtest/engine/smc/trail-config';

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

interface ManagementState {
  breakevenActivated: boolean;
  peakFavorablePrice: number;
  originalSlPrice: number;
  /** Selects trailConfig — TP1 leg trails differently than RUNNER. */
  trailKey: 'TP1' | 'RUNNER';
}

@Injectable()
export class LivePositionManagerService implements OnModuleInit {
  private readonly logger = new Logger(LivePositionManagerService.name);
  private readonly liveMode: boolean;
  private readonly pairs: string[];
  /** Skip modify-broker calls if SL change is below this threshold (price units). */
  private readonly minSlChangeAbs: Record<string, number> = {
    XAUUSD: 0.05,    // 5 cents
    EURUSD: 0.0001,  // 1 pip
    GBPUSD: 0.0001,
    USDJPY: 0.01,    // 1 pip in JPY
  };

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
      this.logger.log('LIVE_MODE=false — position manager DORMANT');
      return;
    }
    this.logger.log(`Position manager active for ${this.pairs.join(', ')}`);
    await this.redis.subscribe(REDIS_CHANNELS.CANDLE_STORED, (message) => {
      try {
        const data = JSON.parse(message);
        if (data.timeframe !== Timeframe.M15) return;
        if (!this.liveControl.isRunning()) return;
        if (!this.pairs.includes(data.symbol)) return;
        this.manageSymbol(data.symbol).catch((err) =>
          this.logger.error(
            `[${data.symbol}] manageSymbol failed: ${(err as Error).message}`,
            (err as Error).stack,
          ),
        );
      } catch {
        // ignore bad payloads
      }
    });
  }

  /** Public for testing / manual triggers. */
  async manageSymbol(symbol: string): Promise<void> {
    const open = await this.prisma.trade.findMany({
      where: { symbol, status: 'OPEN', mt5Ticket: { not: null } },
    });
    if (open.length === 0) return;

    const brokerPositions = await this.fetchBrokerPositions(symbol);
    const byTicket = new Map(brokerPositions.map((p) => [p.ticket, p]));

    const latestM15 = await this.fetchLatestM15(symbol);
    if (!latestM15) {
      this.logger.warn(`[${symbol}] no recent M15 candle — skipping management`);
      return;
    }
    const spread = getSpread(symbol, latestM15.openTime);

    for (const trade of open) {
      const broker = byTicket.get(trade.mt5Ticket!);
      if (!broker) {
        // Reconciler will pick this up on the next pass — broker side has
        // closed but our DB is still OPEN.
        continue;
      }

      const state = this.parseState(trade, broker);
      const trailConfig: RegimeTradeParams = state.trailKey === 'TP1' ? SMC_TP1_TRAIL : SMC_RUNNER_TRAIL;

      const pos: SimulatedPosition = {
        side: trade.side as 'BUY' | 'SELL',
        entryPrice: trade.entryPrice,
        slPrice: broker.sl > 0 ? broker.sl : trade.slPrice, // broker is truth
        originalSlPrice: state.originalSlPrice,
        tpPrice: broker.tp > 0 ? broker.tp : trade.tpPrice,
        breakevenActivated: state.breakevenActivated,
        peakFavorablePrice: state.peakFavorablePrice,
        lotSize: trade.lotSize,
        entryTime: trade.createdAt.toISOString(),
        entryIndex: 0,
        setupTags: state.trailKey === 'TP1' ? ['SMC', 'TP1'] : ['SMC', 'RUNNER'],
        h1Bias: trade.side === 'BUY' ? 'BULLISH' : 'BEARISH',
        rsiAtEntry: 50,
        atrAtEntry: 0,
        trailConfig,
        regimeAtEntry: 'WEAK_TREND',
      };

      const updated = updatePositionManagement(pos, latestM15, spread);
      if (updated === pos) continue; // nothing changed

      const newState: ManagementState = {
        breakevenActivated: updated.breakevenActivated,
        peakFavorablePrice: updated.peakFavorablePrice,
        originalSlPrice: state.originalSlPrice,
        trailKey: state.trailKey,
      };

      // Decide if we need to call broker. Broker calls are expensive and
      // each is a network round-trip — skip if SL change is below the
      // pip-scale threshold for this symbol.
      const slChanged = Math.abs(updated.slPrice - pos.slPrice) >= (this.minSlChangeAbs[symbol] ?? 0.0001);
      const tpRemoved = pos.tpPrice !== null && updated.tpPrice === null;
      const tpChanged = updated.tpPrice !== null && pos.tpPrice !== null
        && Math.abs(updated.tpPrice - pos.tpPrice) >= (this.minSlChangeAbs[symbol] ?? 0.0001);

      if (slChanged || tpRemoved || tpChanged) {
        try {
          await this.modifyBrokerPosition(trade.mt5Ticket!, updated.slPrice, updated.tpPrice);
          this.logger.log(
            `[${symbol}] ticket=${trade.mt5Ticket} BE=${updated.breakevenActivated} SL ${pos.slPrice.toFixed(5)}→${updated.slPrice.toFixed(5)}${tpRemoved ? ' (TP removed)' : ''}`,
          );
        } catch (err) {
          // Don't update DB state if broker rejected — we'd drift out of sync.
          this.logger.error(
            `[${symbol}] ticket=${trade.mt5Ticket} broker modify failed: ${(err as Error).message}`,
          );
          continue;
        }
      }

      await this.prisma.trade.update({
        where: { id: trade.id },
        data: {
          slPrice: updated.slPrice,
          tpPrice: updated.tpPrice ?? trade.tpPrice, // never persist null tpPrice
          managementState: newState as any,
        },
      });
    }
  }

  // ─── helpers ──────────────────────────────────────────────────────────

  private parseState(trade: { managementState: any; entryPrice: number; slPrice: number; setupTags?: string[] }, broker: BrokerPosition): ManagementState {
    const raw = (trade.managementState ?? {}) as Partial<ManagementState>;
    const trailKey: 'TP1' | 'RUNNER' = (() => {
      if (raw.trailKey === 'TP1' || raw.trailKey === 'RUNNER') return raw.trailKey;
      // Fallback: tags contain 'TP1' = TP1 leg, otherwise RUNNER (single-pos pairs).
      const tags = (trade as any).setupTags ?? [];
      return Array.isArray(tags) && tags.includes('TP1') ? 'TP1' : 'RUNNER';
    })();
    return {
      breakevenActivated: raw.breakevenActivated ?? false,
      peakFavorablePrice: raw.peakFavorablePrice ?? broker.entryPrice ?? trade.entryPrice,
      originalSlPrice: raw.originalSlPrice ?? trade.slPrice,
      trailKey,
    };
  }

  private async fetchBrokerPositions(symbol: string): Promise<BrokerPosition[]> {
    const url = `${SERVICE_URLS.EXECUTION}/positions`;
    const res = await firstValueFrom(
      this.httpService.get<BrokerPosition[]>(url, { params: { symbol } }),
    );
    return res.data ?? [];
  }

  private async fetchLatestM15(symbol: string): Promise<BacktestCandle | null> {
    const row = await this.prisma.candle.findFirst({
      where: { symbol, timeframe: Timeframe.M15 },
      orderBy: { openTime: 'desc' },
    });
    if (!row) return null;
    return {
      symbol: row.symbol,
      timeframe: row.timeframe,
      openTime: row.openTime.toISOString(),
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
    };
  }

  private async modifyBrokerPosition(ticket: number, slPrice: number, tpPrice: number | null): Promise<void> {
    const url = `${SERVICE_URLS.EXECUTION}/positions/${ticket}/modify`;
    await firstValueFrom(
      this.httpService.post(url, {
        slPrice,
        tpPrice: tpPrice ?? 0,
      }),
    );
  }
}
