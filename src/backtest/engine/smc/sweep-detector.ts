/**
 * SMC sweep detector — pair-agnostic.
 *
 * Detects H1 liquidity sweeps and classifies them into REVERSAL vs CONTINUATION
 * mode based on D1 ADX. All thresholds come from the supplied SmcPairConfig
 * — no hardcoded constants.
 */
import { BacktestCandle, IndicatorState, D1Bias } from '../types';
import { PendingSetup, SmcMode, SmcPairConfig } from './types';

/**
 * Locate the H1 candle index that formed the swung swing — used by the
 * Path-3 pre-sweep validity gates. Walks back from the sweep candle
 * looking for a candle whose extreme matches the swept price level.
 *
 * Returns null if no exact match is found within `searchBack` bars (rare;
 * the sweep detector emits levels that came from real fractals, so a
 * matching candle should exist).
 */
export function findSweptSwingIdx(
  h1Candles: BacktestCandle[],
  sweepCandleIdx: number,
  side: 'BUY' | 'SELL',
  sweepLevel: number,
  searchBack = 50,
): number | null {
  const isLowSwing = side === 'BUY'; // BUY trade = sweep of swing low
  const minIdx = Math.max(1, sweepCandleIdx - searchBack);
  for (let k = sweepCandleIdx - 1; k >= minIdx; k--) {
    const c = h1Candles[k];
    const level = isLowSwing ? c.low : c.high;
    if (level === sweepLevel) return k;
  }
  return null;
}

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
 *
 * If `cfg.useAnchorSweeps` is true (forex pairs, e.g. EURUSD), routes to
 * `detectAnchorSweep` instead — only fires at PDH/PDL anchor levels.
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
  // Per-pair routing — anchor-sweep variant is opt-in. XAUUSD never sets the
  // flag so its path is identical to the legacy logic below.
  if (cfg.useAnchorSweeps) {
    return detectAnchorSweep(
      h1Candles, h1Indicators, h1Idx, d1Bias, d1Adx, cfg,
      d1Candles, d1Indicators, currentTime,
    );
  }

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
    sweepTime: bar.openTime,
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

// ─── Anchor-sweep variant (opt-in via cfg.useAnchorSweeps) ──────────────────

import { getAnchorLevels } from './anchor-levels';

/**
 * Anchor-level sweep detector. Same mode-selection logic as the generic
 * variant, but only fires when the swept level IS a known anchor (PDH/PDL
 * in step 4.1; Asian / Weekly added in 4.3).
 *
 * The sweep candle's wick must pierce an anchor by `cfg.sweepBufferAtr` ATR,
 * and the body must close back inside.
 *
 * For pairs whose retail liquidity actually clusters at session anchors
 * (most forex), this filters out the noise sweeps that random-swing detection
 * would generate. For pairs whose liquidity is structural (gold, crypto,
 * indices), the generic-swing variant is more appropriate.
 */
function detectAnchorSweep(
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

  // Resolve anchors active at THIS H1 bar's open (use the bar's own time
  // so PDH/PDL is computed relative to the bar's calendar day, not the
  // M15 caller's time).
  const anchors = getAnchorLevels(h1Candles, bar.openTime);

  const buffer = atr * cfg.sweepBufferAtr;
  const mid = (bar.high + bar.low) / 2;
  const isTrending = d1Adx >= cfg.trendingD1Adx;
  const mode: SmcMode = isTrending ? 'CONTINUATION' : 'REVERSAL';

  const autoFilter = cfg.autoModeFilter !== false;
  if (autoFilter && mode === 'CONTINUATION' && d1Candles && currentTime) {
    if (!isContinuationSafe(d1Candles, d1Indicators ?? null, currentTime, d1Bias)) {
      return null;
    }
  }

  // Displacement confirmation — if cfg.anchorDisplacementAtr > 0 and the
  // NEXT H1 bar exists, require a strong-bodied move in the trade direction
  // before approving. Filters chop sweeps with no follow-through.
  const dispAtr = cfg.anchorDisplacementAtr ?? 0;
  const nextBar = h1Idx + 1 < h1Candles.length ? h1Candles[h1Idx + 1] : null;
  const passesDisplacement = (direction: 'BUY' | 'SELL'): boolean => {
    if (dispAtr <= 0) return true;     // disabled — auto-pass
    if (!nextBar) return false;        // can't verify → reject
    const body = direction === 'BUY'
      ? nextBar.close - nextBar.open   // positive when bullish
      : nextBar.open - nextBar.close;  // positive when bearish
    return body >= dispAtr * atr;
  };

  const make = (
    direction: 'BUY' | 'SELL',
    level: number,
    wick: number,
  ): PendingSetup => ({
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
    sweepTime: bar.openTime,
  });

  // Iterate all upper anchors (PDH, AsianHigh, WeeklyHigh) — first hit wins
  const highs: Array<[number | null, string]> = [
    [anchors.pdh, 'PDH'],
    [anchors.asianHigh, 'ASIAN_H'],
    [anchors.weeklyHigh, 'WEEKLY_H'],
  ];
  for (const [level] of highs) {
    if (level === null) continue;
    if (bar.high > level + buffer && bar.close < level) {
      const dir: 'SELL' = 'SELL';
      if (!passesDisplacement(dir)) continue;
      if (mode === 'REVERSAL') return make(dir, level, bar.high);
      if (mode === 'CONTINUATION' && d1Bias === 'BEARISH') {
        return make(dir, level, bar.high);
      }
    }
  }

  // Lower anchors (PDL, AsianLow, WeeklyLow)
  const lows: Array<[number | null, string]> = [
    [anchors.pdl, 'PDL'],
    [anchors.asianLow, 'ASIAN_L'],
    [anchors.weeklyLow, 'WEEKLY_L'],
  ];
  for (const [level] of lows) {
    if (level === null) continue;
    if (bar.low < level - buffer && bar.close > level) {
      const dir: 'BUY' = 'BUY';
      if (!passesDisplacement(dir)) continue;
      if (mode === 'REVERSAL') return make(dir, level, bar.low);
      if (mode === 'CONTINUATION' && d1Bias === 'BULLISH') {
        return make(dir, level, bar.low);
      }
    }
  }

  return null;
}
