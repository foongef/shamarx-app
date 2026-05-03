/**
 * SMC sweep detector — pair-agnostic.
 *
 * Detects H1 liquidity sweeps and classifies them into REVERSAL vs CONTINUATION
 * mode based on D1 ADX. All thresholds come from the supplied SmcPairConfig
 * — no hardcoded constants.
 */
import { BacktestCandle, IndicatorState, D1Bias } from '../types';
import { PendingSetup, SmcMode, SmcPairConfig } from './types';

/** Find the most recent H1 swing high within the lookback window (3-bar fractal). */
export function findRecentSwingHigh(
  h1Candles: BacktestCandle[],
  h1Idx: number,
  lookback: number,
): number | null {
  for (let k = h1Idx - 1; k >= Math.max(1, h1Idx - lookback); k--) {
    if (k + 1 >= h1Candles.length) continue;
    if (h1Candles[k].high > h1Candles[k - 1].high && h1Candles[k].high > h1Candles[k + 1].high) {
      return h1Candles[k].high;
    }
  }
  return null;
}

export function findRecentSwingLow(
  h1Candles: BacktestCandle[],
  h1Idx: number,
  lookback: number,
): number | null {
  for (let k = h1Idx - 1; k >= Math.max(1, h1Idx - lookback); k--) {
    if (k + 1 >= h1Candles.length) continue;
    if (h1Candles[k].low < h1Candles[k - 1].low && h1Candles[k].low < h1Candles[k + 1].low) {
      return h1Candles[k].low;
    }
  }
  return null;
}

/**
 * Auto-mode safety check for CONTINUATION setups.
 * Returns true iff the D1 trend is structurally healthy enough to keep going
 * after a stop-hunt sweep:
 *   1. D1 ADX is rising (current > 3-bar-ago) — trend gaining strength
 *   2. D1 EMA20 vs EMA50 aligns with the bias direction — proper stack
 *   3. ADX < 50 — not in trend-exhaustion zone
 *   4. Price not over-extended from EMA50 (within 6% — pulled-back enough to continue)
 *
 * If any check fails, CONTINUATION is unsafe → setup is rejected.
 * This is pair-agnostic; works on any instrument without per-pair tuning.
 */
export function isContinuationSafe(
  d1Candles: BacktestCandle[],
  d1Indicators: IndicatorState | null,
  currentTime: string,
  d1Bias: D1Bias,
): boolean {
  if (!d1Indicators || d1Candles.length === 0) return true; // can't gate without data — pass

  // Find D1 idx at or before current time
  const t = new Date(currentTime).getTime();
  let lo = 0, hi = d1Candles.length - 1, idx = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (new Date(d1Candles[m].openTime).getTime() <= t) { idx = m; lo = m + 1; }
    else hi = m - 1;
  }
  if (idx < 50) return false; // need ≥50 D1 bars for EMA50

  // 1. ADX rising — current vs 3 bars ago
  const adxNow = d1Indicators.adx14[idx];
  const adxPrev = d1Indicators.adx14[idx - 3];
  if (isNaN(adxNow) || isNaN(adxPrev)) return false;
  if (adxNow <= adxPrev) return false;

  // 3. ADX not over-extended
  if (adxNow > 50) return false;

  // 2. Proper EMA stack
  const ema20 = d1Indicators.ema20[idx];
  const ema50 = d1Indicators.ema50[idx];
  if (isNaN(ema20) || isNaN(ema50)) return false;
  if (d1Bias === 'BULLISH' && ema20 <= ema50) return false;
  if (d1Bias === 'BEARISH' && ema20 >= ema50) return false;

  // 4. Price not over-extended from EMA50
  const close = d1Candles[idx].close;
  if (close <= 0) return false;
  const distPct = Math.abs(close - ema50) / close;
  if (distPct > 0.06) return false;

  return true;
}

/**
 * H1 sweep detector with mode selection:
 *   - REVERSAL mode (D1 ranging or below trending threshold): sweep wick + body
 *     closes BACK INSIDE → trade against the sweep
 *   - CONTINUATION mode (D1 trending, ADX ≥ trendingD1Adx, structurally healthy):
 *     sweep wick on the OPPOSITE side of D1 trend, body closes back with D1
 *     → trade WITH D1 trend
 */
export function detectSweep(
  h1Candles: BacktestCandle[],
  h1Indicators: IndicatorState,
  h1Idx: number,
  d1Bias: D1Bias,
  d1Adx: number,
  cfg: SmcPairConfig,
  d1Candles?: BacktestCandle[],
  d1Indicators?: IndicatorState | null,
  currentTime?: string,
): PendingSetup | null {
  if (h1Idx < 5 || h1Idx >= h1Candles.length) return null;
  const bar = h1Candles[h1Idx];
  const atr = h1Indicators.atr14[h1Idx];
  const baseline = h1Indicators.atrBaseline[h1Idx];
  if (isNaN(atr) || atr <= 0) return null;
  if (!isNaN(baseline) && baseline > 0 && atr / baseline > cfg.atrSpikeLimit) return null;

  const buffer = atr * cfg.sweepBufferAtr;
  const mid = (bar.high + bar.low) / 2;
  const isTrending = d1Adx >= cfg.trendingD1Adx;
  const mode: SmcMode = isTrending ? 'CONTINUATION' : 'REVERSAL';

  // Auto-mode filter: reject CONTINUATION if D1 structure is unhealthy.
  // Default: enabled (autoModeFilter undefined or true).
  const autoFilter = cfg.autoModeFilter !== false;
  if (autoFilter && mode === 'CONTINUATION' && d1Candles && currentTime) {
    if (!isContinuationSafe(d1Candles, d1Indicators ?? null, currentTime, d1Bias)) {
      return null;
    }
  }

  const make = (direction: 'BUY' | 'SELL', level: number, wick: number): PendingSetup => ({
    direction,
    sweepLevel: level,
    sweepWick: wick,
    sweepMid: mid,
    sweepCandleAtr: atr,
    sweepCandleHigh: bar.high,
    sweepCandleLow: bar.low,
    detectedAtH1Idx: h1Idx,
    expiresAtH1Idx: h1Idx + cfg.setupExpiryH1Bars,
    mode,
  });

  if (mode === 'CONTINUATION') {
    if (d1Bias === 'BULLISH') {
      const swingLow = findRecentSwingLow(h1Candles, h1Idx, cfg.recentSwingLookbackH1);
      if (swingLow !== null && bar.low < swingLow - buffer && bar.close > swingLow) {
        return make('BUY', swingLow, bar.low);
      }
    } else if (d1Bias === 'BEARISH') {
      const swingHigh = findRecentSwingHigh(h1Candles, h1Idx, cfg.recentSwingLookbackH1);
      if (swingHigh !== null && bar.high > swingHigh + buffer && bar.close < swingHigh) {
        return make('SELL', swingHigh, bar.high);
      }
    }
    return null;
  }

  // REVERSAL mode
  const swingHigh = findRecentSwingHigh(h1Candles, h1Idx, cfg.recentSwingLookbackH1);
  if (swingHigh !== null && bar.high > swingHigh + buffer && bar.close < swingHigh) {
    return make('SELL', swingHigh, bar.high);
  }
  const swingLow = findRecentSwingLow(h1Candles, h1Idx, cfg.recentSwingLookbackH1);
  if (swingLow !== null && bar.low < swingLow - buffer && bar.close > swingLow) {
    return make('BUY', swingLow, bar.low);
  }

  return null;
}
