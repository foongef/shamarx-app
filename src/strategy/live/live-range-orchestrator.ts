/**
 * LiveRangeOrchestrator — second strategy alongside LiveSmcOrchestrator.
 *
 * Implements Range Reversion in low-ADX regimes: when D1 ADX is below
 * the trending threshold AND M15 RSI is at an extreme, fade the move
 * targeting a return to the M15 EMA20 mean. Mathematically orthogonal
 * to stop-hunt reversal — the two strategies fire in mutually exclusive
 * regimes by construction.
 *
 * State per pair:
 *   - lastTriggerM15Time — for the dedup check
 *   - cooldownBarsRemaining — decremented on every evaluate() call
 *   - riskManager — independent from SMC's risk manager (per-strategy
 *     drawdown / consecutive-loss tracking)
 *
 * Wire-up: LiveStrategyService and ReplayEngine call evaluate() in the
 * same fan-out loop as LiveSmcOrchestrator. Both implement
 * IStrategyOrchestrator.
 */
import { Injectable, Logger } from '@nestjs/common';
import { computeIndicators } from '../../backtest/engine/indicator-calculator';
import { getInstrumentConfig } from '../../backtest/engine/instrument-config';
import { getSpread } from '../../backtest/engine/spread-model';
import { RiskManager } from '../../backtest/engine/risk-manager';
import { getRangePairConfig } from '../../backtest/engine/range/pairs';
import {
  detectRangeReversion,
  rangeSlAnchor,
} from '../../backtest/engine/range/range-detector';
import { BacktestCandle, EngineConfig, IndicatorState } from '../../backtest/engine/types';
import { SmcLiveSignal } from './smc-live-evaluator';
import { LiveContext, PrecomputedIndicators } from './live-smc-orchestrator';
import { IStrategyOrchestrator } from './strategy.interface';

interface RangeState {
  /** ISO openTime of the last M15 candle that triggered a setup (or
   *  fired a trade). Used for the minBarsBetweenTriggers dedup. */
  lastTriggerM15Time: string | null;
  /** Cooldown bars after a stop-out. Decrements every evaluate() call. */
  cooldownBarsRemaining: number;
  /** Per-pair RiskManager — independent from SMC's. Daily loss /
   *  consecutive losses / drawdown brakes are tracked per-strategy
   *  per-pair so a slump in one strategy doesn't pause the other. */
  riskManager: RiskManager;
}

@Injectable()
export class LiveRangeOrchestrator implements IStrategyOrchestrator {
  readonly name = 'range-reversion';

  private readonly logger = new Logger(LiveRangeOrchestrator.name);
  private readonly states = new Map<string, RangeState>();

  defaultRiskCfg: { initialBalance: number; riskPercent: number; maxOpenPositions: number } = {
    initialBalance: 10000,
    riskPercent: 1.5,
    maxOpenPositions: 4,
  };

  setDefaultRiskCfg(cfg: { initialBalance: number; riskPercent: number; maxOpenPositions: number }): void {
    this.defaultRiskCfg = cfg;
  }

  reset(symbol: string): void {
    this.states.delete(symbol);
  }

  resetAll(): void {
    this.states.clear();
  }

  serialize(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [sym, s] of this.states.entries()) {
      out[sym] = {
        lastTriggerM15Time: s.lastTriggerM15Time,
        cooldownBarsRemaining: s.cooldownBarsRemaining,
      };
    }
    return out;
  }

  restore(snapshot: Record<string, any>): void {
    this.states.clear();
    for (const [sym, raw] of Object.entries(snapshot ?? {})) {
      this.states.set(sym, {
        lastTriggerM15Time: raw.lastTriggerM15Time ?? null,
        cooldownBarsRemaining: typeof raw.cooldownBarsRemaining === 'number' ? raw.cooldownBarsRemaining : 0,
        riskManager: this.buildRiskManager(sym),
      });
    }
  }

  evaluate(
    symbol: string,
    m15Candles: BacktestCandle[],
    h1Candles: BacktestCandle[],
    d1Candles: BacktestCandle[],
    ctx: LiveContext,
    precomputed?: PrecomputedIndicators,
    cursor?: { m15: number; h1: number; d1: number },
  ): SmcLiveSignal | null {
    void h1Candles; // not used by Range Reversion (H1 input kept for IStrategy uniformity)
    const m15Len = cursor ? cursor.m15 : m15Candles.length;
    const d1Len = cursor ? cursor.d1 : d1Candles.length;

    if (m15Len < 30) return null;

    const cfg = getRangePairConfig(symbol);
    if (!cfg || !cfg.enabled) return null; // disabled per pair

    const lastM15 = m15Candles[m15Len - 1];
    const state = this.getOrCreateState(symbol);

    // Decrement cooldown on every M15 close (mirrors SMC's bar-counter logic)
    if (state.cooldownBarsRemaining > 0) {
      state.cooldownBarsRemaining--;
      return null;
    }

    // Killzone gate
    const utcHour = new Date(lastM15.openTime).getUTCHours();
    const inKillzone = cfg.killzones.some(([s, e]) => utcHour >= s && utcHour < e);
    if (!inKillzone) return null;

    // Dedup gate — minimum bars between consecutive triggers
    if (state.lastTriggerM15Time) {
      const lastTs = new Date(state.lastTriggerM15Time).getTime();
      const nowTs = new Date(lastM15.openTime).getTime();
      const barsSince = Math.floor((nowTs - lastTs) / (15 * 60 * 1000));
      if (barsSince < cfg.minBarsBetweenTriggers) return null;
    }

    // Same-direction stacking guard — don't fire if a position in the
    // entry direction is already open on this pair.
    // (We don't know the direction yet; resolved after detectRangeReversion.)

    // Same maxOpenPositions cap as SMC — shared broker state
    const maxOpenPositions = ctx.maxOpenPositions ?? this.defaultRiskCfg.maxOpenPositions;
    if (ctx.totalOpenPositions >= maxOpenPositions) return null;

    // Indicators
    const m15Indicators = precomputed?.m15 ?? computeIndicators(m15Candles);
    const d1Indicators: IndicatorState | null = precomputed
      ? precomputed.d1
      : d1Candles.length > 30
        ? computeIndicators(d1Candles)
        : null;

    // Detect setup
    const setup = detectRangeReversion(
      m15Candles,
      m15Indicators,
      d1Indicators,
      d1Candles,
      m15Len - 1,
      {
        rsiOversold: cfg.rsiOversold,
        rsiOverbought: cfg.rsiOverbought,
        d1AdxMaxForRange: cfg.d1AdxMaxForRange,
        atrSpikeRatio: cfg.atrSpikeRatio,
        minMeanDistanceAtr: cfg.minMeanDistanceAtr,
      },
    );
    if (!setup) return null;

    // Same-direction stacking guard now that we know direction
    if (ctx.openDirections.has(setup.direction)) return null;

    // Entry / SL / TP
    const instrumentConfig = getInstrumentConfig(symbol);
    const { pricePrecision } = instrumentConfig;
    const factor = Math.pow(10, pricePrecision);
    const round = (n: number) => Math.round(n * factor) / factor;

    const spread = getSpread(symbol, lastM15.openTime);
    const entryPrice = setup.direction === 'BUY' ? lastM15.close + spread : lastM15.close - spread;
    const slPrice = rangeSlAnchor(m15Candles, setup, cfg.slBufferAtrM15);
    const slDistance = Math.abs(entryPrice - slPrice);
    if (slDistance <= 0) return null;

    const tpPrice =
      setup.direction === 'BUY'
        ? entryPrice + setup.meanDistance * cfg.tpFraction
        : entryPrice - setup.meanDistance * cfg.tpFraction;

    // RiskManager: state-machine + lot sizing
    if (!state.riskManager.canTrade(lastM15.openTime, ctx.totalOpenPositions)) return null;

    const riskCfg: EngineConfig = {
      symbol,
      initialBalance: ctx.accountEquity,
      riskPercent: ctx.riskPercent ?? parseFloat(process.env.RISK_PERCENT || '1.5'),
      maxDailyLossPercent: 4.0,
      maxConsecutiveLosses: 5,
      maxOpenPositions,
      strategyVersion: 'SMC-V2',
    };
    const riskManager = new RiskManager(riskCfg);
    const slPoints = slDistance * factor;
    const totalLot = riskManager.calculateLotSize(
      slPoints,
      60,
      'RANGING',
      50,
      entryPrice,
    );
    if (totalLot < 0.01) return null;

    const session = utcHour < 12 ? 'LONDON' : 'NY';
    const setupTags = ['RANGE', 'REVERSAL', session];
    const reason =
      `RANGE ${setup.direction} on ${symbol} — RSI=${setup.rsiAtTrigger.toFixed(1)} ` +
      `(${setup.direction === 'BUY' ? 'oversold' : 'overbought'}), targeting EMA20 mean ` +
      `${setup.meanDistance.toFixed(5)} away, ${session}`;

    const signal: SmcLiveSignal = {
      symbol,
      side: setup.direction,
      entryPrice: round(entryPrice),
      slPrice: round(slPrice),
      tpPrice: round(tpPrice),
      totalLot,
      legs: [
        { lotSize: totalLot, tpPrice: round(tpPrice), setupTags: [...setupTags, 'RUNNER'] },
      ],
      mode: 'REVERSAL',
      h1SweepTime: lastM15.openTime, // reuse field for dedup; not strictly an H1 sweep here
      reason,
      smcContext: {
        sweptLevel: setup.meanPrice, // chart shows EMA20 as the "target"
        sweptHigh: m15Candles[setup.triggerM15Idx].high,
        sweptLow: m15Candles[setup.triggerM15Idx].low,
        sweepCandleTime: m15Candles[setup.triggerM15Idx].openTime,
        d1Bias: 'NEUTRAL',
      },
    };

    state.lastTriggerM15Time = lastM15.openTime;
    return signal;
  }

  recordEntry(_symbol: string, _signal: SmcLiveSignal): void {
    // No additional state change beyond what evaluate() set —
    // lastTriggerM15Time was stamped at signal-build time.
    void _symbol; void _signal;
  }

  recordExit(
    symbol: string,
    exitReason: 'SL' | 'TP' | 'OTHER',
    exitTimeIso: string,
    pnl?: number,
  ): void {
    const state = this.getOrCreateState(symbol);
    const cfg = getRangePairConfig(symbol);
    if (!cfg) return;

    let bars: number;
    if (exitReason === 'TP') bars = 2;
    else if (exitReason === 'SL') bars = cfg.cooldownBarsAfterSL;
    else bars = 1;
    state.cooldownBarsRemaining = Math.max(state.cooldownBarsRemaining, bars);

    if (typeof pnl === 'number') {
      const reasonForRm =
        exitReason === 'SL' ? 'SL' : exitReason === 'TP' ? 'TP' : 'FORCED_CLOSE';
      state.riskManager.recordTrade(pnl, exitTimeIso, reasonForRm);
    }
  }

  // ─── internals ──────────────────────────────────────────────────────────

  private getOrCreateState(symbol: string): RangeState {
    let s = this.states.get(symbol);
    if (!s) {
      s = {
        lastTriggerM15Time: null,
        cooldownBarsRemaining: 0,
        riskManager: this.buildRiskManager(symbol),
      };
      this.states.set(symbol, s);
    }
    return s;
  }

  private buildRiskManager(symbol: string): RiskManager {
    return new RiskManager({
      symbol,
      initialBalance: this.defaultRiskCfg.initialBalance,
      riskPercent: this.defaultRiskCfg.riskPercent,
      maxDailyLossPercent: 4.0,
      maxConsecutiveLosses: 5,
      maxOpenPositions: this.defaultRiskCfg.maxOpenPositions,
      strategyVersion: 'SMC-V2',
    });
  }
}
