/**
 * Fair Value Gap (FVG) detector — pair-agnostic.
 *
 * An FVG is a 3-candle imbalance where the middle candle is so impulsive
 * that the wick of the preceding candle and the wick of the following
 * candle do NOT overlap. The unfilled gap between them is "fair value"
 * the market typically returns to mitigate.
 *
 *   Bullish FVG: candle[i+1].low > candle[i-1].high
 *     → gap zone is [candle[i-1].high, candle[i+1].low]
 *
 *   Bearish FVG: candle[i+1].high < candle[i-1].low
 *     → gap zone is [candle[i+1].high, candle[i-1].low]
 *
 * SMC traders consider an FVG "active" until price returns to fill it
 * (mitigation). Unmitigated FVGs in the bias direction are entry zones.
 *
 * This module is pure compute — takes candle arrays in, returns zone
 * data out. No engine mutation, no broker calls.
 */
import { BacktestCandle } from '../types';

export interface Fvg {
  /** Top of the gap zone (highest price). */
  top: number;
  /** Bottom of the gap zone (lowest price). */
  bottom: number;
  /** Index of the middle (impulsive) candle in the source array. */
  candleIdx: number;
  /** ISO openTime of the impulsive candle — for serialisation / display. */
  candleTime: string;
  /** True for a bullish FVG (price gapped UP — supports long entries on
   *  retest); false for bearish (price gapped DOWN — supports shorts). */
  isBullish: boolean;
  /** True once price has returned through the gap (mitigated). Mitigation
   *  rules: bullish FVG is mitigated if a subsequent candle's low ≤ top
   *  of the gap; bearish if a subsequent candle's high ≥ bottom of the
   *  gap. We use the entry-into-zone definition (full fill) for now. */
  mitigated: boolean;
  /** Bar index at which mitigation was first detected (or -1 if active). */
  mitigatedAtIdx: number;
  /** Vertical size of the gap (top - bottom) — useful for filtering tiny
   *  gaps that are noise rather than real imbalances. */
  height: number;
}

export interface DetectFvgsOptions {
  /** Look back at most this many candles from `endIdx` (exclusive) when
   *  scanning for FVGs. Default: scan the whole series. */
  lookback?: number;
  /** Index of the most recent candle to consider as the i+1 confirmation.
   *  Default: candles.length - 1 (the latest closed bar). */
  endIdx?: number;
  /** Drop FVGs whose height is less than this fraction of the candle's
   *  ATR — filters noise. Set to 0 to keep everything. */
  minHeightAtrFraction?: number;
  /** ATR series (parallel to candles) used for the size filter. Required
   *  if minHeightAtrFraction > 0. */
  atr?: number[];
}

/**
 * Scan a candle series for all FVGs and report each one's mitigation
 * status as of `endIdx`. Returns FVGs in chronological order.
 *
 * Returns BOTH active and mitigated FVGs by default — callers can filter
 * `.mitigated === false` if they only want fresh ones.
 */
export function detectFvgs(
  candles: BacktestCandle[],
  options: DetectFvgsOptions = {},
): Fvg[] {
  const endIdx = Math.min(options.endIdx ?? candles.length - 1, candles.length - 1);
  const lookback = options.lookback ?? endIdx;
  const startIdx = Math.max(1, endIdx - lookback);
  const minAtrFrac = options.minHeightAtrFraction ?? 0;
  const atr = options.atr;

  const out: Fvg[] = [];

  // Need at least 3 candles centered on i: [i-1, i, i+1].
  // Walk i from startIdx+1 to endIdx-1.
  for (let i = startIdx + 1; i <= endIdx - 1; i++) {
    const prev = candles[i - 1];
    const next = candles[i + 1];

    // Bullish FVG: gap between prev.high and next.low (in that order)
    if (next.low > prev.high) {
      const fvg = makeFvg(candles, i, prev.high, next.low, true, endIdx);
      if (passesAtrFilter(fvg, i, minAtrFrac, atr)) out.push(fvg);
      continue;
    }
    // Bearish FVG: gap between next.high and prev.low
    if (next.high < prev.low) {
      const fvg = makeFvg(candles, i, next.high, prev.low, false, endIdx);
      if (passesAtrFilter(fvg, i, minAtrFrac, atr)) out.push(fvg);
    }
  }

  return out;
}

/**
 * Returns the most recent unmitigated FVG that supports the given
 * direction at `endIdx`, or null if none. Used by the entry-gate logic.
 *
 * "Supports" means:
 *   - For BUY entries: a bullish FVG (price gapped up; retests are
 *     value buys)
 *   - For SELL entries: a bearish FVG
 *
 * Returns the *closest* (by candleIdx) unmitigated FVG in the relevant
 * direction. The caller checks whether the entry price is inside or
 * near the FVG zone.
 */
export function nearestUnmitigatedFvg(
  candles: BacktestCandle[],
  side: 'BUY' | 'SELL',
  options: DetectFvgsOptions = {},
): Fvg | null {
  const all = detectFvgs(candles, options);
  const wantBullish = side === 'BUY';
  // Walk newest → oldest, return first match that's still active and
  // direction-aligned.
  for (let i = all.length - 1; i >= 0; i--) {
    const f = all[i];
    if (f.mitigated) continue;
    if (f.isBullish !== wantBullish) continue;
    return f;
  }
  return null;
}

/**
 * Convenience gate: returns true if there is at least one unmitigated
 * FVG in the entry direction within `maxDistanceAtr` of the entry price.
 *
 * Used as an optional gate on the orchestrator. When enabled (per pair
 * config), only fires the trade if this returns true.
 */
export function hasSupportingFvg(
  candles: BacktestCandle[],
  side: 'BUY' | 'SELL',
  entryPrice: number,
  maxDistanceAtr: number,
  atr: number[],
  endIdx: number,
): { ok: true; fvg: Fvg } | { ok: false } {
  const fvg = nearestUnmitigatedFvg(candles, side, { endIdx, atr });
  if (!fvg) return { ok: false };

  const currentAtr = atr[endIdx] ?? 0;
  if (currentAtr <= 0) {
    // No ATR available — skip distance gate, just require existence.
    return { ok: true, fvg };
  }

  // Entry must be within maxDistanceAtr × ATR of the FVG zone (or inside it).
  const inside = entryPrice >= fvg.bottom && entryPrice <= fvg.top;
  if (inside) return { ok: true, fvg };

  const distance = entryPrice > fvg.top ? entryPrice - fvg.top : fvg.bottom - entryPrice;
  if (distance <= maxDistanceAtr * currentAtr) return { ok: true, fvg };

  return { ok: false };
}

// ─── internals ───────────────────────────────────────────────────────────

function makeFvg(
  candles: BacktestCandle[],
  candleIdx: number,
  bottom: number,
  top: number,
  isBullish: boolean,
  endIdx: number,
): Fvg {
  const fvg: Fvg = {
    top,
    bottom,
    candleIdx,
    candleTime: candles[candleIdx].openTime,
    isBullish,
    mitigated: false,
    mitigatedAtIdx: -1,
    height: top - bottom,
  };
  // Walk forward from candleIdx+2 to endIdx looking for first mitigation.
  // Mitigation = subsequent candle's wick re-enters the gap.
  for (let k = candleIdx + 2; k <= endIdx; k++) {
    const c = candles[k];
    if (isBullish) {
      // Bullish FVG mitigated when price wicks BACK DOWN into the gap.
      if (c.low <= top) {
        fvg.mitigated = true;
        fvg.mitigatedAtIdx = k;
        break;
      }
    } else {
      // Bearish FVG mitigated when price wicks UP into the gap.
      if (c.high >= bottom) {
        fvg.mitigated = true;
        fvg.mitigatedAtIdx = k;
        break;
      }
    }
  }
  return fvg;
}

function passesAtrFilter(
  fvg: Fvg,
  candleIdx: number,
  minAtrFrac: number,
  atr?: number[],
): boolean {
  if (minAtrFrac <= 0) return true;
  if (!atr || atr.length === 0) return true;
  const localAtr = atr[candleIdx] ?? 0;
  if (localAtr <= 0) return true;
  return fvg.height >= minAtrFrac * localAtr;
}
