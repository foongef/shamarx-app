/**
 * Live SMC evaluator — stateless function that takes a rolling candle buffer
 * and produces a trade signal (or null) for the most recent M15 candle.
 *
 * Reuses the SAME sweep detector, anchor levels, and risk-manager logic that
 * the backtest uses (in src/backtest/engine/smc/). The only difference is the
 * entry point: backtest calls these in a loop over historical data; live calls
 * them once per M15 candle close.
 *
 * Returns null when no setup is valid. The strategy service treats null as
 * "no action" — the next M15 close re-evaluates from scratch.
 */
import { Injectable, Logger } from '@nestjs/common';
import { getSmcPairConfig } from '../../backtest/engine/smc/pairs';
import { detectSweep } from '../../backtest/engine/smc/sweep-detector';
import { computeIndicators } from '../../backtest/engine/indicator-calculator';
import { getD1Bias } from '../../backtest/engine/strategy-evaluator';
import { RiskManager } from '../../backtest/engine/risk-manager';
import { getInstrumentConfig } from '../../backtest/engine/instrument-config';
import { getSpread } from '../../backtest/engine/spread-model';
import {
  BacktestCandle,
  EngineConfig,
  D1Bias,
} from '../../backtest/engine/types';

export interface SmcLiveSignalLeg {
  lotSize: number;
  tpPrice: number;
  setupTags: string[];
}

export interface SmcLiveSignal {
  symbol: string;
  side: 'BUY' | 'SELL';
  entryPrice: number;
  slPrice: number;
  tpPrice: number;          // primary TP (TP1 if ladder, TP2 if single-position)
  totalLot: number;          // sum of all legs
  legs: SmcLiveSignalLeg[];  // 1 or 2 legs
  mode: 'REVERSAL' | 'CONTINUATION';
  h1SweepTime: string;       // H1 candle close time of the sweep — for de-dup
  reason: string;            // human-readable why we entered
  /** SMC annotation context — captured at signal-fire so the dashboard's
   *  "View on chart" expander can render an annotated chart explaining the
   *  setup. All fields are populated by the orchestrator from the
   *  PendingSetup + D1 indicators in scope at signal time. */
  smcContext?: {
    sweptLevel: number;       // the H1 swing extreme that was swept
    sweptHigh: number;        // sweep candle high
    sweptLow: number;         // sweep candle low
    sweepCandleTime: string;  // ISO openTime of the H1 sweep candle
    d1Bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  };
}

export interface LiveEvaluationContext {
  /** Current account equity ($) — used for risk-based lot sizing. */
  accountEquity: number;
  /** Current open-position directions for THIS pair, to prevent stacking. */
  openDirections: Set<'BUY' | 'SELL'>;
  /** H1 sweep timestamps already actioned in this session — avoid double-entry. */
  recentlyEnteredSweepTimes: Set<string>;
}

@Injectable()
export class SmcLiveEvaluator {
  private readonly logger = new Logger(SmcLiveEvaluator.name);

  /**
   * Evaluate the latest M15 candle and return a signal or null.
   *
   * @param symbol           e.g. "EURUSD"
   * @param m15Candles       rolling buffer, last ~100 closed candles
   * @param h1Candles        rolling buffer, last ~500 closed candles (90d warmup recommended)
   * @param d1Candles        rolling buffer, last ~400 closed candles
   * @param ctx              live state passed in from the caller
   * @param riskPercent      override risk percent (from runtime config, not env)
   */
  evaluate(
    symbol: string,
    m15Candles: BacktestCandle[],
    h1Candles: BacktestCandle[],
    d1Candles: BacktestCandle[],
    ctx: LiveEvaluationContext,
    riskPercent?: number,
  ): SmcLiveSignal | null {
    if (m15Candles.length < 30 || h1Candles.length < 30) return null;

    const cfg = getSmcPairConfig(symbol);
    const instrumentConfig = getInstrumentConfig(symbol);
    const { pricePrecision } = instrumentConfig;
    const factor = Math.pow(10, pricePrecision);

    const m15Indicators = computeIndicators(m15Candles);
    const h1Indicators = computeIndicators(h1Candles);
    const d1Indicators = d1Candles.length > 30 ? computeIndicators(d1Candles) : null;

    const lastM15 = m15Candles[m15Candles.length - 1];
    const lastClosedH1Idx = h1Candles.length - 1;

    // 1. D1 trend filter — skip if HTF is structurally choppy
    const d1Bias: D1Bias = d1Indicators
      ? getD1Bias(d1Candles, d1Indicators, lastM15.openTime)
      : 'NEUTRAL';
    const d1Adx = d1Indicators ? d1Indicators.adx14[d1Candles.length - 1] || 0 : 0;
    if (d1Adx < cfg.d1AdxFloor) {
      return null;
    }

    // 2. Killzone gate
    const utcHour = new Date(lastM15.openTime).getUTCHours();
    const inZone = cfg.killzones.some(([s, e]) => utcHour >= s && utcHour < e);
    if (!inZone) return null;

    // 3. News blackout (if configured)
    if ((cfg.newsBlackoutMinutes ?? 0) > 0) {
      const { isInBlackout } = require('../../backtest/engine/news-calendar');
      if (isInBlackout(lastM15.openTime, cfg.newsBlackoutMinutes)) return null;
    }

    // 4. Detect sweep on the most recent CLOSED H1 bar
    const setup = detectSweep(
      h1Candles,
      h1Indicators,
      lastClosedH1Idx,
      d1Bias,
      d1Adx,
      cfg,
      d1Candles,
      d1Indicators,
      lastM15.openTime,
    );
    if (!setup) return null;
    if ((cfg.disabledModes ?? []).includes(setup.mode)) return null;

    // 5. De-dup — don't re-enter on a sweep we've already actioned this session
    const sweepTime = h1Candles[setup.detectedAtH1Idx].openTime;
    if (ctx.recentlyEnteredSweepTimes.has(sweepTime)) return null;

    // 6. Same-direction stacking guard
    if (ctx.openDirections.has(setup.direction)) return null;

    // 7. Build entry / SL / TP
    const spread = getSpread(symbol, lastM15.openTime);
    const halfSpread = spread / 2;
    const m15Atr = m15Indicators.atr14[m15Candles.length - 1];
    const slBuffer = !isNaN(m15Atr) && m15Atr > 0
      ? m15Atr * cfg.slBufferAtrM15
      : setup.sweepCandleAtr * cfg.slBufferAtrM15;

    const entryPrice = setup.direction === 'BUY'
      ? lastM15.close + halfSpread
      : lastM15.close - halfSpread;

    let slPrice: number;
    if (setup.mode === 'CONTINUATION') {
      slPrice = setup.direction === 'BUY'
        ? setup.sweepCandleLow - slBuffer
        : setup.sweepCandleHigh + slBuffer;
    } else {
      slPrice = setup.direction === 'BUY'
        ? setup.sweepWick - slBuffer
        : setup.sweepWick + slBuffer;
    }

    const slPoints = Math.abs(entryPrice - slPrice);
    if (slPoints <= 0) return null;

    // 8. Wide-SL filter (iter5)
    if ((cfg.maxSlAtrM15 ?? 0) > 0 && !isNaN(m15Atr) && m15Atr > 0) {
      if (slPoints / m15Atr > cfg.maxSlAtrM15!) return null;
    }

    // 9. Risk-managed lot sizing
    const riskCfg: EngineConfig = {
      symbol,
      initialBalance: ctx.accountEquity,
      riskPercent: riskPercent ?? parseFloat(process.env.RISK_PERCENT || '1.5'),
      maxDailyLossPercent: 4.0,
      maxConsecutiveLosses: 5,
      maxOpenPositions: 4,
      strategyVersion: 'SMC-V2',
    };
    const riskManager = new RiskManager(riskCfg);
    const totalLot = riskManager.calculateLotSize(slPoints, 60, 'WEAK_TREND', 50, entryPrice);
    const usesLadder = cfg.tp1PartialFraction > 0;

    if (usesLadder ? totalLot < 0.02 : totalLot < 0.01) return null;

    const tp2Price = setup.direction === 'BUY'
      ? entryPrice + slPoints * cfg.tp2R
      : entryPrice - slPoints * cfg.tp2R;

    const session = utcHour < 12 ? 'LONDON' : 'NY';
    const baseTags = ['SMC', 'SWEEP', session, setup.mode];

    const round = (n: number) => Math.round(n * factor) / factor;

    if (!usesLadder) {
      return {
        symbol,
        side: setup.direction,
        entryPrice: round(entryPrice),
        slPrice: round(slPrice),
        tpPrice: round(tp2Price),
        totalLot,
        legs: [{ lotSize: totalLot, tpPrice: round(tp2Price), setupTags: [...baseTags, 'RUNNER'] }],
        mode: setup.mode,
        h1SweepTime: sweepTime,
        reason: `${setup.mode} ${setup.direction} on ${cfg.symbol} — D1 ADX=${d1Adx.toFixed(1)} (≥${cfg.d1AdxFloor}), bias=${d1Bias}, ${session}`,
      };
    }

    // Ladder: TP1 partial + Runner
    const tp1Lot = Math.max(0.01, Math.round(totalLot * cfg.tp1PartialFraction * 100) / 100);
    const runnerLot = Math.max(0.01, Math.round((totalLot - tp1Lot) * 100) / 100);
    if (tp1Lot < 0.01 || runnerLot < 0.01) return null;

    const tp1Price = setup.direction === 'BUY'
      ? entryPrice + slPoints * cfg.tp1R
      : entryPrice - slPoints * cfg.tp1R;

    return {
      symbol,
      side: setup.direction,
      entryPrice: round(entryPrice),
      slPrice: round(slPrice),
      tpPrice: round(tp1Price),    // primary view = TP1
      totalLot,
      legs: [
        { lotSize: tp1Lot, tpPrice: round(tp1Price), setupTags: [...baseTags, 'TP1'] },
        { lotSize: runnerLot, tpPrice: round(tp2Price), setupTags: [...baseTags, 'RUNNER'] },
      ],
      mode: setup.mode,
      h1SweepTime: sweepTime,
      reason: `${setup.mode} ${setup.direction} on ${cfg.symbol} — D1 ADX=${d1Adx.toFixed(1)} (≥${cfg.d1AdxFloor}), bias=${d1Bias}, ${session}, ladder`,
    };
  }
}
