/**
 * V6-alt: SMC engine main loop — pair-agnostic.
 *
 * Reads per-pair tuning from `pairs/` registry. To run on a new pair:
 *   - Add config in pairs/<symbol>.ts
 *   - Register it in pairs/index.ts
 *   - The engine will pick it up automatically via getSmcPairConfig(symbol)
 *
 * Returns the same `BacktestResult` shape as V5.5b/V6 so comparison is
 * execution-equal — same PositionSimulator, same RiskManager, same metrics.
 */
import { Logger } from '@nestjs/common';
import {
  BacktestCandle,
  ClosedTrade,
  SimulatedPosition,
  EngineConfig,
  IndicatorState,
  D1Bias,
} from '../types';
import { computeIndicators } from '../indicator-calculator';
import { getD1Bias } from '../strategy-evaluator';
import { checkPositionExit, forceClosePosition, updatePositionManagement } from '../position-simulator';
import { RiskManager } from '../risk-manager';
import { PerformanceTracker } from '../performance-tracker';
import { calculateMetrics } from '../metrics-calculator';
import { getSpread } from '../spread-model';
import { getInstrumentConfig } from '../instrument-config';

import { PendingSetup } from './types';
import { detectSweep } from './sweep-detector';
import { SMC_TP1_TRAIL, SMC_RUNNER_TRAIL } from './trail-config';
import { getSmcPairConfig } from './pairs';

function inKillzone(time: string, killzones: Array<[number, number]>): boolean {
  const h = new Date(time).getUTCHours();
  return killzones.some(([start, end]) => h >= start && h < end);
}

/** Find the index whose bar contains the given timestamp (binary search). */
function indexForTime(candles: BacktestCandle[], time: string): number {
  const t = new Date(time).getTime();
  let lo = 0, hi = candles.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (new Date(candles[mid].openTime).getTime() <= t) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** D1 ADX at the given time, or 0 if unavailable. */
function d1AdxAt(d1Candles: BacktestCandle[], d1Indicators: IndicatorState | null, time: string): number {
  if (!d1Indicators || d1Candles.length === 0) return 0;
  const idx = indexForTime(d1Candles, time);
  if (idx < 0) return 0;
  const adx = d1Indicators.adx14[idx];
  return isNaN(adx) ? 0 : adx;
}

export function runSmcBacktest(
  m15Candles: BacktestCandle[],
  h1Candles: BacktestCandle[],
  _h4Candles: BacktestCandle[],
  d1Candles: BacktestCandle[],
  config: EngineConfig,
): { trades: ClosedTrade[]; metrics: ReturnType<typeof calculateMetrics> } {
  const logger = new Logger('SmcEngine');
  const instrumentConfig = getInstrumentConfig(config.symbol);
  const { commissionPerLot, lotSizeUnits, pricePrecision } = instrumentConfig;
  const factor = Math.pow(10, pricePrecision);

  const cfg = getSmcPairConfig(config.symbol);

  if (h1Candles.length < 30) {
    logger.warn('Not enough H1 candles for SMC engine — returning empty result');
    return { trades: [], metrics: calculateMetrics([], config.initialBalance) };
  }

  const m15Indicators = computeIndicators(m15Candles);
  const h1Indicators = computeIndicators(h1Candles);
  const d1Indicators = d1Candles.length > 0 ? computeIndicators(d1Candles) : null;

  const riskManager = new RiskManager(config);
  const tracker = new PerformanceTracker();
  const openPositions: SimulatedPosition[] = [];
  const closed: ClosedTrade[] = [];
  let pending: PendingSetup[] = [];
  let lastProcessedH1 = -1;
  let cooldownUntil = -1;

  for (let i = 0; i < m15Candles.length; i++) {
    const candle = m15Candles[i];
    const spread = getSpread(config.symbol, candle.openTime);
    const currentDate = candle.openTime.substring(0, 10);

    // 1. Manage open positions
    for (let j = 0; j < openPositions.length; j++) {
      openPositions[j] = updatePositionManagement(openPositions[j], candle, spread);
    }
    for (let j = openPositions.length - 1; j >= 0; j--) {
      const pos = openPositions[j];
      const commission = pos.lotSize * commissionPerLot;
      const result = checkPositionExit(pos, candle, spread, commission, lotSizeUnits, config.symbol);
      if (result) {
        riskManager.recordTrade(result.pnl, candle.openTime, result.exitReason);
        tracker.recordTrade(result);
        closed.push(result);
        openPositions.splice(j, 1);
        if (result.exitReason === 'TP') cooldownUntil = i + 2;
        else if (result.exitReason === 'SL') cooldownUntil = i + cfg.slCooldownBars;
        else cooldownUntil = i + 1;
      }
    }

    // 2. On each new closed H1 bar, run sweep detection
    const h1Idx = indexForTime(h1Candles, candle.openTime);
    if (h1Idx > lastProcessedH1 && h1Idx >= 1) {
      const closedH1Idx = h1Idx - 1;
      if (closedH1Idx > lastProcessedH1) {
        const d1Bias: D1Bias = d1Indicators
          ? getD1Bias(d1Candles, d1Indicators, candle.openTime)
          : 'NEUTRAL';
        const d1Adx = d1AdxAt(d1Candles, d1Indicators, candle.openTime);
        if (d1Adx >= cfg.d1AdxFloor) {
          const setup = detectSweep(
            h1Candles, h1Indicators, closedH1Idx,
            d1Bias, d1Adx, cfg,
            // pass D1 context so the auto-mode filter can run health checks
            d1Candles, d1Indicators, candle.openTime,
          );
          // Skip setups whose mode is explicitly disabled by config (override).
          if (setup && !(cfg.disabledModes ?? []).includes(setup.mode)) {
            pending.push(setup);
          }
        }
        lastProcessedH1 = closedH1Idx;
      }
    }

    // 3. Expire stale setups
    pending = pending.filter((s) => h1Idx <= s.expiresAtH1Idx);

    // 4. Trade gates
    if (i <= cooldownUntil) continue;
    // News blackout — opt-in per pair. EURUSD as a macro pair benefits from
    // sitting out NFP/FOMC/CPI/ECB windows.
    if ((cfg.newsBlackoutMinutes ?? 0) > 0) {
      // Lazy require to avoid circular imports
      const { isInBlackout } = require('../news-calendar');
      if (isInBlackout(candle.openTime, cfg.newsBlackoutMinutes)) continue;
    }
    if (!riskManager.canTrade(currentDate, openPositions.length)) continue;
    if (!inKillzone(candle.openTime, cfg.killzones)) continue;

    // 5. Enter on first M15 bar after sweep detection (no extra confirmation).
    for (let s = pending.length - 1; s >= 0; s--) {
      const setup = pending[s];

      // No same-direction stacking
      if (openPositions.some((p) => p.side === setup.direction)) continue;

      // Build entry/SL
      const m15Atr = m15Indicators.atr14[i];
      const slBuffer = !isNaN(m15Atr)
        ? m15Atr * cfg.slBufferAtrM15
        : setup.sweepCandleAtr * cfg.slBufferAtrM15;
      const halfSpread = spread / 2;
      const entryPrice = setup.direction === 'BUY'
        ? candle.close + halfSpread
        : candle.close - halfSpread;

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
      if (slPoints <= 0) {
        pending.splice(s, 1);
        continue;
      }

      // Iter 5: max-SL filter (scaling fix).
      // Reject setups where SL distance exceeds the configured M15-ATR cap.
      // Wide-SL setups statistically have lower win rate; without this filter,
      // large accounts (where the lot floor doesn't bind) take them all and
      // dilute edge into negative territory. Mimics the implicit selection
      // small accounts get from the honest-risk cap.
      if ((cfg.maxSlAtrM15 ?? 0) > 0 && !isNaN(m15Atr) && m15Atr > 0) {
        const slAtrRatio = slPoints / m15Atr;
        if (slAtrRatio > cfg.maxSlAtrM15!) {
          pending.splice(s, 1);
          continue;
        }
      }

      // Sizing — total lot from risk manager (already honest-risk-capped).
      // Required minimum depends on whether the pair uses the TP1+runner
      // ladder (needs 0.02 — 0.01 for each leg) or single-position (needs 0.01).
      // Note: quality-tiered risk (iter3) was tested and rejected — no
      // reliable improvement, so stays flat at neutral quality=60.
      const totalLot = riskManager.calculateLotSize(slPoints, 60, 'WEAK_TREND', 50, entryPrice);
      const usesLadder = cfg.tp1PartialFraction > 0;
      if (usesLadder) {
        if (totalLot < 0.02) continue;  // need both legs at 0.01 minimum
      } else {
        if (totalLot < 0.01) continue;
      }

      const tp2Price = setup.direction === 'BUY'
        ? entryPrice + slPoints * cfg.tp2R
        : entryPrice - slPoints * cfg.tp2R;

      const session = new Date(candle.openTime).getUTCHours() < 12 ? 'LONDON' : 'NY';
      const baseTags = ['SMC', 'SWEEP', session, setup.mode];

      const baseFields = {
        side: setup.direction,
        entryPrice: Math.round(entryPrice * factor) / factor,
        slPrice: Math.round(slPrice * factor) / factor,
        originalSlPrice: Math.round(slPrice * factor) / factor,
        breakevenActivated: false,
        peakFavorablePrice: entryPrice,
        entryTime: candle.openTime,
        entryIndex: i,
        h1Bias: setup.direction === 'BUY' ? 'BULLISH' : 'BEARISH',
        rsiAtEntry: m15Indicators.rsi14[i] ?? 50,
        atrAtEntry: !isNaN(m15Atr) ? m15Atr : setup.sweepCandleAtr,
        regimeAtEntry: 'WEAK_TREND' as const,
      };

      if (!usesLadder) {
        // Single-position pair (e.g. EURUSD): runner only, no TP1 partial.
        openPositions.push({
          ...baseFields,
          lotSize: totalLot,
          tpPrice: Math.round(tp2Price * factor) / factor,
          setupTags: [...baseTags, 'RUNNER'],
          trailConfig: SMC_RUNNER_TRAIL,
        });
      } else {
        // TP1 + Runner ladder pair (e.g. XAUUSD)
        const tp1Lot = Math.max(0.01, Math.round(totalLot * cfg.tp1PartialFraction * 100) / 100);
        const runnerLot = Math.max(0.01, Math.round((totalLot - tp1Lot) * 100) / 100);
        if (tp1Lot < 0.01 || runnerLot < 0.01) continue;
        const tp1Price = setup.direction === 'BUY'
          ? entryPrice + slPoints * cfg.tp1R
          : entryPrice - slPoints * cfg.tp1R;
        openPositions.push({
          ...baseFields,
          lotSize: tp1Lot,
          tpPrice: Math.round(tp1Price * factor) / factor,
          setupTags: [...baseTags, 'TP1'],
          trailConfig: SMC_TP1_TRAIL,
        });
        openPositions.push({
          ...baseFields,
          lotSize: runnerLot,
          tpPrice: Math.round(tp2Price * factor) / factor,
          setupTags: [...baseTags, 'RUNNER'],
          trailConfig: SMC_RUNNER_TRAIL,
        });
      }

      pending.splice(s, 1);
      cooldownUntil = i + 1;
      break;
    }
  }

  // Force-close any remaining open positions at the last candle
  if (openPositions.length > 0 && m15Candles.length > 0) {
    const lastCandle = m15Candles[m15Candles.length - 1];
    for (const pos of openPositions) {
      const commission = pos.lotSize * commissionPerLot;
      const result = forceClosePosition(pos, lastCandle.close, lastCandle.openTime, commission, lotSizeUnits, config.symbol);
      riskManager.recordTrade(result.pnl, lastCandle.openTime, result.exitReason);
      tracker.recordTrade(result);
      closed.push(result);
    }
  }

  const metrics = calculateMetrics(closed, config.initialBalance);
  logger.log(
    `[V6-alt SMC ${config.symbol}] complete: ${metrics.totalTrades} trades, winRate=${metrics.winRate}%, PnL=$${metrics.totalPnl}, maxDD=${metrics.maxDrawdownPercent}%`,
  );
  return { trades: closed, metrics };
}
