/**
 * Range Reversion detector — pure compute, pair-agnostic.
 *
 * Fires when the market is in chop regime (low D1 ADX) AND M15 RSI is
 * at an extreme. The mechanic: in a range-bound market, RSI extremes
 * tend to mean-revert toward the M15 EMA20. We fade the extreme and
 * target the mean.
 *
 * This is the COMPLEMENT to stop-hunt reversal: stop-hunt fires when
 * D1 bias is clear (trending or moderate-ADX), Range Reversion fires
 * when D1 bias is NEUTRAL (chop). The two strategies are mutually
 * exclusive by regime — they don't compete for the same trades.
 */
import { BacktestCandle, IndicatorState } from '../types';

export interface RangeReversionSetup {
  direction: 'BUY' | 'SELL';
  /** RSI value at the trigger candle. Used in the reason string + future
   *  conviction-multiplier sizing. */
  rsiAtTrigger: number;
  /** Triggering M15 candle index (in the full M15 array). */
  triggerM15Idx: number;
  /** Distance from triggering close to mean target (M15 EMA20). Used as
   *  a sanity check — if distance < 1×ATR the trade isn't worth taking. */
  meanDistance: number;
  /** ATR at trigger time — used for SL placement. */
  atrAtTrigger: number;
  /** EMA20 mean target — TP price. */
  meanPrice: number;
}

export interface DetectRangeOptions {
  /** RSI threshold for oversold (BUY trigger). Default 25. */
  rsiOversold?: number;
  /** RSI threshold for overbought (SELL trigger). Default 75. */
  rsiOverbought?: number;
  /** D1 ADX above this → market is trending → skip Range Reversion.
   *  Should match the same threshold the SMC strategy uses for D1 bias
   *  detection so the two strategies are regime-orthogonal. */
  d1AdxMaxForRange?: number;
  /** M15 ATR ratio above this → news spike or extreme volatility →
   *  skip. Range mean-reversion fails during news. */
  atrSpikeRatio?: number;
  /** Minimum distance (in M15-ATR multiples) from trigger close to
   *  M15 EMA20 mean. Prevents tiny-edge trades. Default 1.0. */
  minMeanDistanceAtr?: number;
  /** M15 lookback to count "recent triggers" for the dedup check.
   *  Prevents re-firing on the same RSI excursion. Default 8 bars. */
  recentTriggerLookback?: number;
}

/**
 * Evaluate a single M15 close for a Range Reversion setup. Returns
 * `null` if no setup; otherwise the triggered direction + context.
 *
 * Pre-conditions checked (in cheap-fail order):
 *  1. D1 ADX < d1AdxMaxForRange (market is in chop, not trending)
 *  2. M15 ATR isn't an extreme spike vs ATR baseline
 *  3. M15 RSI is at an extreme (< oversold OR > overbought)
 *  4. Mean (M15 EMA20) is at least minMeanDistanceAtr × ATR away
 *     in the favourable direction
 */
export function detectRangeReversion(
  m15Candles: BacktestCandle[],
  m15Indicators: IndicatorState,
  d1Indicators: IndicatorState | null,
  d1Candles: BacktestCandle[],
  m15Idx: number,
  options: DetectRangeOptions = {},
): RangeReversionSetup | null {
  const rsiOversold = options.rsiOversold ?? 25;
  const rsiOverbought = options.rsiOverbought ?? 75;
  const d1AdxMaxForRange = options.d1AdxMaxForRange ?? 22;
  const atrSpikeRatio = options.atrSpikeRatio ?? 2.0;
  const minMeanDistanceAtr = options.minMeanDistanceAtr ?? 1.0;

  if (m15Idx < 30 || m15Idx >= m15Candles.length) return null;
  const candle = m15Candles[m15Idx];
  const rsi = m15Indicators.rsi14[m15Idx];
  const atr = m15Indicators.atr14[m15Idx];
  const ema20 = m15Indicators.ema20[m15Idx];
  const baseline = m15Indicators.atrBaseline[m15Idx] ?? atr;

  if (!isFinite(rsi) || !isFinite(atr) || !isFinite(ema20) || atr <= 0) return null;

  // 1. D1 ADX gate — only fire in chop
  if (d1Indicators && d1Candles.length > 0) {
    const d1IdxAtCurrent = findD1Idx(d1Candles, candle.openTime);
    if (d1IdxAtCurrent >= 0) {
      const d1Adx = d1Indicators.adx14[d1IdxAtCurrent];
      if (isFinite(d1Adx) && d1Adx > d1AdxMaxForRange) return null;
    }
  }

  // 2. ATR-spike filter — skip news spikes
  if (baseline > 0 && atr / baseline > atrSpikeRatio) return null;

  // 3. RSI extreme gate
  let direction: 'BUY' | 'SELL';
  if (rsi <= rsiOversold) direction = 'BUY';
  else if (rsi >= rsiOverbought) direction = 'SELL';
  else return null;

  // 4. Mean-distance gate — must have profit room toward EMA20
  const triggerClose = candle.close;
  const meanDistance =
    direction === 'BUY' ? ema20 - triggerClose : triggerClose - ema20;
  if (meanDistance < minMeanDistanceAtr * atr) return null;

  return {
    direction,
    rsiAtTrigger: rsi,
    triggerM15Idx: m15Idx,
    meanDistance,
    atrAtTrigger: atr,
    meanPrice: ema20,
  };
}

/**
 * Returns the SL anchor for a Range Reversion setup — just beyond the
 * extreme of the trigger candle, with an ATR buffer. Same structural-stop
 * philosophy as stop-hunt reversal.
 */
export function rangeSlAnchor(
  m15Candles: BacktestCandle[],
  setup: RangeReversionSetup,
  bufferAtrMult: number,
): number {
  const c = m15Candles[setup.triggerM15Idx];
  const buffer = bufferAtrMult * setup.atrAtTrigger;
  return setup.direction === 'BUY' ? c.low - buffer : c.high + buffer;
}

// ─── internals ───────────────────────────────────────────────────────────

function findD1Idx(d1Candles: BacktestCandle[], asOfIso: string): number {
  const asOfMs = new Date(asOfIso).getTime();
  let lo = 0;
  let hi = d1Candles.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = new Date(d1Candles[mid].openTime).getTime();
    if (t <= asOfMs) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}
