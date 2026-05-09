/**
 * Break of Structure (BOS) detector — pair-agnostic.
 *
 * In SMC parlance, BOS = price closes BEYOND a recent swing high/low in
 * the direction of the prevailing bias. It confirms that the trend is
 * intact after a sweep of liquidity.
 *
 * Used as an entry-gate: a sweep entry that has a confirming BOS ahead
 * of it has higher probability than one without. We look for BOS that
 * happened AFTER the sweep and BEFORE the entry candle.
 *
 *   For BUY entries (after bullish sweep, bullish bias):
 *     BOS = some candle close > prior swing high after the sweep
 *
 *   For SELL entries:
 *     BOS = some candle close < prior swing low after the sweep
 *
 * Reuses the existing swing-high / swing-low fractal from sweep-detector
 * to define "swing" consistently.
 */
import { BacktestCandle } from '../types';
import { findRecentSwingHigh, findRecentSwingLow } from './sweep-detector';

export interface Bos {
  /** Price level that was broken (the prior swing extreme). */
  level: number;
  /** Index of the candle whose close confirmed the break. */
  brokenAtIdx: number;
  /** ISO openTime of the breaking candle. */
  brokenAtTime: string;
  /** True if the broken structure was a swing HIGH (bullish BOS). */
  isBullish: boolean;
}

/**
 * Returns the most recent BOS in the given direction within `lookback`
 * bars of `endIdx`, or null if none.
 *
 * `swingLookback` is how far back we look to define the relevant swing
 * high/low. Should be larger than `lookback` so the swing was meaningful
 * before we look for breaks of it.
 */
export function detectBos(
  candles: BacktestCandle[],
  side: 'BUY' | 'SELL',
  endIdx: number,
  lookback: number,
  swingLookback: number,
): Bos | null {
  if (candles.length < swingLookback + 2) return null;

  const isBullish = side === 'BUY';

  // Walk newest → oldest looking for a candle whose close broke beyond
  // the swing extreme that existed BEFORE that candle.
  const startIdx = Math.max(swingLookback, endIdx - lookback);
  for (let k = endIdx; k >= startIdx; k--) {
    if (k < 1) break;
    const swing = isBullish
      ? findRecentSwingHigh(candles, k, swingLookback)
      : findRecentSwingLow(candles, k, swingLookback);
    if (swing == null) continue;

    const c = candles[k];
    const broke = isBullish ? c.close > swing : c.close < swing;
    if (broke) {
      return {
        level: swing,
        brokenAtIdx: k,
        brokenAtTime: c.openTime,
        isBullish,
      };
    }
  }
  return null;
}

/**
 * Gate: returns true if a BOS in the entry direction occurred between
 * `sinceIdx` (inclusive) and `endIdx` (inclusive). Used to require that
 * structure confirmed AFTER the sweep but BEFORE we fire the entry.
 */
export function hasBosAfter(
  candles: BacktestCandle[],
  side: 'BUY' | 'SELL',
  sinceIdx: number,
  endIdx: number,
  swingLookback: number,
): { ok: true; bos: Bos } | { ok: false } {
  const lookback = Math.max(1, endIdx - sinceIdx);
  const bos = detectBos(candles, side, endIdx, lookback, swingLookback);
  if (bos && bos.brokenAtIdx >= sinceIdx) {
    return { ok: true, bos };
  }
  return { ok: false };
}
