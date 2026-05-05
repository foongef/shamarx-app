/**
 * LIVE strategy service — runs V6-alt SMC evaluation on each M15 candle close
 * and places orders via execution-service.
 *
 * Activates ONLY when LIVE_MODE=true. The legacy BOS evaluator in
 * `strategy.service.ts` continues to exist (not invoked) for backward compat.
 */
import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { randomUUID } from 'crypto';
import { PrismaService } from '@app/prisma';
import { RedisService, REDIS_CHANNELS } from '@app/redis';
import { Timeframe, SERVICE_URLS, CandleDto } from '@app/common';
import {
  SmcLiveEvaluator,
  SmcLiveSignal,
  LiveEvaluationContext,
} from './smc-live-evaluator';
import { LiveControlService } from './live-control.service';
import { BacktestCandle } from '../../backtest/engine/types';

const M15_BUFFER = 100;
const H1_BUFFER = 500;
const D1_BUFFER = 400;

@Injectable()
export class LiveStrategyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LiveStrategyService.name);
  private readonly liveMode: boolean;
  private readonly pairs: string[];
  private readonly evaluator: SmcLiveEvaluator;
  private subscribed = false;

  /** Sweep timestamps already actioned this session per symbol — prevents double-entry */
  private actionedSweeps = new Map<string, Set<string>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly httpService: HttpService,
    private readonly config: ConfigService,
    private readonly liveControl: LiveControlService,
  ) {
    this.liveMode = (this.config.get<string>('LIVE_MODE') || 'false').toLowerCase() === 'true';
    const pairsCsv = this.config.get<string>('STRATEGY_PAIRS') || 'XAUUSD,EURUSD,GBPUSD,USDJPY';
    this.pairs = pairsCsv.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    this.evaluator = new SmcLiveEvaluator();
  }

  async onModuleInit() {
    if (!this.liveMode) {
      this.logger.log('LIVE_MODE=false — live strategy is DORMANT (legacy BOS service still bound)');
      return;
    }
    this.logger.log(`LIVE_MODE=true — V6-alt SMC live trading enabled for ${this.pairs.join(', ')}`);
    for (const pair of this.pairs) this.actionedSweeps.set(pair, new Set());
    await this.redis.subscribe(REDIS_CHANNELS.CANDLE_STORED, (message) => {
      try {
        const data = JSON.parse(message);
        if (data.timeframe !== Timeframe.M15) return;
        const symbol = (data.symbol || '').toUpperCase();
        if (!this.pairs.includes(symbol)) return;
        // Runtime gate: skip evaluation when the engine is "paused" via the
        // dashboard Start/Stop button, even when LIVE_MODE=true.
        if (!this.liveControl.isRunning()) return;
        this.evaluatePair(symbol).catch((err) =>
          this.logger.error(`Live eval failed for ${symbol}: ${err.message}`, err.stack),
        );
      } catch (err) {
        this.logger.warn(`Bad CANDLE_STORED payload: ${(err as Error).message}`);
      }
    });
    this.subscribed = true;
  }

  async onModuleDestroy() {
    // RedisService manages its own subscription lifecycle.
    this.subscribed = false;
  }

  /** Public entrypoint for manual / scheduled triggers (e.g. from controllers) */
  async evaluatePair(symbol: string): Promise<SmcLiveSignal | null> {
    const [m15, h1, d1, openPositions, account] = await Promise.all([
      this.fetchCandles(symbol, Timeframe.M15, M15_BUFFER),
      this.fetchCandles(symbol, Timeframe.H1, H1_BUFFER),
      this.fetchCandles(symbol, Timeframe.D1, D1_BUFFER),
      this.fetchOpenPositions(symbol),
      this.fetchAccount(),
    ]);

    const ctx: LiveEvaluationContext = {
      accountEquity: account.equity,
      openDirections: new Set(openPositions.map((p) => p.side as 'BUY' | 'SELL')),
      recentlyEnteredSweepTimes: this.actionedSweeps.get(symbol) ?? new Set(),
    };

    const signal = this.evaluator.evaluate(
      symbol,
      m15,
      h1,
      d1,
      ctx,
      this.liveControl.getRiskPercent(),
    );
    if (!signal) {
      this.logger.debug(`[${symbol}] no signal`);
      return null;
    }

    this.logger.log(`[${symbol}] signal → ${signal.reason}`);
    await this.placeOrder(signal);
    this.actionedSweeps.get(symbol)?.add(signal.h1SweepTime);
    return signal;
  }

  /**
   * Synthetic test trade — bypasses the SMC evaluator. Used for verifying
   * end-to-end execution path (broker connection, order placement, DB
   * persistence, position-monitor reconciliation).
   *
   * Places a small lot (default 0.01) at the latest candle close with tight
   * SL/TP derived from M15 ATR. Goes through the SAME placeOrder() code path
   * as a real signal, so a successful test trade implies the entire chain
   * works.
   */
  async fireTestTrade(opts: {
    symbol: string;
    side?: 'BUY' | 'SELL';
    lotSize?: number;
    slAtrMult?: number;
    tpRMult?: number;
  }): Promise<SmcLiveSignal> {
    const symbol = opts.symbol.toUpperCase();
    const side: 'BUY' | 'SELL' = opts.side ?? 'BUY';
    const lotSize = opts.lotSize ?? 0.01;
    const slAtrMult = opts.slAtrMult ?? 1.0;
    const tpRMult = opts.tpRMult ?? 2.0;

    if (!this.liveControl.isRunning()) {
      throw new Error('Engine is not running. Start a session first.');
    }
    if (!this.pairs.includes(symbol)) {
      throw new Error(`Pair ${symbol} not in STRATEGY_PAIRS=${this.pairs.join(',')}`);
    }

    const m15 = await this.fetchCandles(symbol, Timeframe.M15, 50);
    if (m15.length < 20) throw new Error(`Not enough M15 candles for ${symbol} to compute ATR`);

    const last = m15[m15.length - 1];
    const entryPrice = last.close;

    // Crude ATR over last 14 bars
    const atr14 = m15.slice(-14).reduce((sum, c, i, arr) => {
      if (i === 0) return sum;
      const tr = Math.max(
        c.high - c.low,
        Math.abs(c.high - arr[i - 1].close),
        Math.abs(c.low - arr[i - 1].close),
      );
      return sum + tr;
    }, 0) / 13;

    const slDistance = atr14 * slAtrMult;
    const slPrice =
      side === 'BUY' ? entryPrice - slDistance : entryPrice + slDistance;
    const tpPrice =
      side === 'BUY' ? entryPrice + slDistance * tpRMult : entryPrice - slDistance * tpRMult;

    const round = (n: number) => {
      // gold pricePrecision=2, JPY=3, others=5
      const decimals = symbol === 'XAUUSD' ? 2 : symbol.endsWith('JPY') ? 3 : 5;
      const factor = Math.pow(10, decimals);
      return Math.round(n * factor) / factor;
    };

    const signal: SmcLiveSignal = {
      symbol,
      side,
      entryPrice: round(entryPrice),
      slPrice: round(slPrice),
      tpPrice: round(tpPrice),
      totalLot: lotSize,
      legs: [
        {
          lotSize,
          tpPrice: round(tpPrice),
          setupTags: ['TEST', 'MANUAL', side],
        },
      ],
      mode: 'REVERSAL',
      h1SweepTime: new Date().toISOString(),
      reason: `TEST trade: ${side} ${symbol} ${lotSize} lot @ ${round(entryPrice)} SL=${round(slPrice)} TP=${round(tpPrice)} (ATR=${atr14.toFixed(5)} × ${slAtrMult})`,
    };

    this.logger.warn(`[TEST-TRADE] firing → ${signal.reason}`);
    await this.placeOrder(signal);
    return signal;
  }

  private async fetchCandles(
    symbol: string,
    timeframe: string,
    count: number,
  ): Promise<BacktestCandle[]> {
    const url = `${SERVICE_URLS.EXECUTION}/candles`;
    const res = await firstValueFrom(
      this.httpService.get<CandleDto[]>(url, { params: { symbol, timeframe, count } }),
    );
    return (res.data || []).map((c) => ({
      symbol,
      timeframe,
      openTime: c.openTime,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));
  }

  private async fetchOpenPositions(
    symbol: string,
  ): Promise<Array<{ ticket: number; side: string; lotSize: number; entryPrice: number; sl: number; tp: number; pnl: number }>> {
    const url = `${SERVICE_URLS.EXECUTION}/positions`;
    const res = await firstValueFrom(
      this.httpService.get(url, { params: { symbol } }),
    );
    return res.data || [];
  }

  private async fetchAccount(): Promise<{ balance: number; equity: number }> {
    const url = `${SERVICE_URLS.EXECUTION}/account`;
    const res = await firstValueFrom(this.httpService.get(url));
    return res.data;
  }

  private async placeOrder(signal: SmcLiveSignal): Promise<void> {
    // Each leg becomes a separate broker order.
    for (const leg of signal.legs) {
      const clientOrderId = randomUUID();
      // Idempotency: refuse if a Trade with this clientOrderId already exists.
      // (Belt-and-braces; uuid collision is astronomically unlikely.)
      const dupe = await this.prisma.trade.findUnique({ where: { clientOrderId } });
      if (dupe) continue;

      try {
        const res = await firstValueFrom(
          this.httpService.post(`${SERVICE_URLS.EXECUTION}/orders`, {
            symbol: signal.symbol,
            side: signal.side,
            lotSize: leg.lotSize,
            entryPrice: signal.entryPrice,
            slPrice: signal.slPrice,
            tpPrice: leg.tpPrice,
            comment: `SMC:${clientOrderId.slice(0, 8)}`,
          }),
        );
        const order = res.data;

        // Persist a CandidateTrade + Trade so dashboard + journal pick it up.
        const candidate = await this.prisma.candidateTrade.create({
          data: {
            symbol: signal.symbol,
            side: signal.side,
            entryPrice: signal.entryPrice,
            slPrice: signal.slPrice,
            tpPrice: leg.tpPrice,
            slPoints: Math.abs(signal.entryPrice - signal.slPrice),
            tpPoints: Math.abs(leg.tpPrice - signal.entryPrice),
            setupTags: leg.setupTags,
            h1Bias: signal.side === 'BUY' ? 'BULLISH' : 'BEARISH',
            rsiValue: 0,
            atrValue: 0,
            spreadAtDetection: 0,
            timeframe: 'M15',
            status: 'APPROVED',
          },
        });

        await this.prisma.trade.create({
          data: {
            candidateId: candidate.id,
            clientOrderId,
            mt5Ticket: order.mt5Ticket ?? null,
            sessionId: this.liveControl.getCurrentSessionId(),
            symbol: signal.symbol,
            side: signal.side,
            lotSize: leg.lotSize,
            entryPrice: signal.entryPrice,
            slPrice: signal.slPrice,
            tpPrice: leg.tpPrice,
            status: 'OPEN',
            statusHistory: [
              { status: 'PENDING', timestamp: new Date().toISOString() },
              { status: 'OPEN', timestamp: new Date().toISOString(), ticket: order.mt5Ticket },
            ],
          },
        });

        await this.redis.publish(REDIS_CHANNELS.TRADE_OPENED, {
          candidateId: candidate.id,
          clientOrderId,
          symbol: signal.symbol,
          side: signal.side,
          lotSize: leg.lotSize,
          entryPrice: signal.entryPrice,
          mt5Ticket: order.mt5Ticket,
        });

        this.logger.log(
          `[${signal.symbol}] OPENED ${signal.side} ${leg.lotSize} lot @${signal.entryPrice} SL=${signal.slPrice} TP=${leg.tpPrice} ticket=${order.mt5Ticket}`,
        );
      } catch (err) {
        const msg = (err as Error).message;
        this.logger.error(`[${signal.symbol}] order failed for leg ${JSON.stringify(leg)}: ${msg}`);
      }
    }
  }
}
