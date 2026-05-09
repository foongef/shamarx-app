/**
 * Order Block (OB) detector — pair-agnostic.
 *
 * In SMC parlance an order block is the LAST opposing candle before an
 * impulsive move that broke market structure (took out a swing high/low).
 * Bullish OB = the last DOWN candle before the impulsive UP move that
 * broke the prior swing high. Bearish OB = mirror.
 *
 * The implementation here uses a pragmatic definition that works on
 * limited candle data:
 *   1. Walk backward from the reference index
 *   2. Find a candle followed within `lookForwardMax` bars by an
 *      impulsive move whose displacement ≥ `displacementAtr × ATR`
 *   3. The last opposing-direction candle within `consolidationMax`
 *      bars before that move is the OB
 *
 * Used as an entry-gate confirmation: a sweep entry near an unmitigated
 * OB in the bias direction has a stronger SMC narrative than one without.
 */
import { BacktestCandle } from '../types';

export interface OrderBlock {
  /** Top of the OB zone — the candle's high (bullish OB) or low (bearish OB) is one bound. */
  top: number;
  /** Bottom of the OB zone. */
  bottom: number;
  /** The OB candle's openTime (ISO). */
  candleTime: string;
  /** Index of the OB candle in the source array. */
  candleIdx: number;
  /** True for a bullish OB (price likely to bounce UP off this zone). */
  isBullish: boolean;
  /** The displacement (in pips, raw price units) of the impulsive move
   *  that confirmed this block — used for sorting / quality filtering. */
  displacement: number;
  /** True if price has already returned through this zone (mitigated). */
  mitigated: boolean;
  mitigatedAtIdx: number;
}

export interface DetectObOptions {
  endIdx?: number;
  /** How many bars to look forward from a candidate OB candle for the
   *  impulsive move that confirms it. Default 4. */
  lookForwardMax?: number;
  /** Minimum displacement (as fraction of ATR) of the confirming move
   *  for this OB to count. Default 1.5. */
  displacementAtrMult?: number;
  /** ATR series parallel to candles (required for displacement filter). */
  atr?: number[];
}

/**
 * Returns all order blocks detected up to `endIdx`, in chronological
 * order. Includes mitigation status as of `endIdx`.
 */
export function detectOrderBlocks(
  candles: BacktestCandle[],
  options: DetectObOptions = {},
): OrderBlock[] {
  const endIdx = Math.min(options.endIdx ?? candles.length - 1, candles.length - 1);
  const lookForward = options.lookForwardMax ?? 4;
  const dispMult = options.displacementAtrMult ?? 1.5;
  const atr = options.atr;

  const out: OrderBlock[] = [];

  // Walk i from 1 to endIdx - 1 looking for opposing candles followed
  // by an impulsive move within `lookForward` bars.
  for (let i = 1; i <= endIdx - 1; i++) {
    const c = candles[i];
    const isDown = c.close < c.open;
    const isUp = c.close > c.open;
    if (!isDown && !isUp) continue;

    const localAtr = atr?.[i] ?? 0;
    if (localAtr <= 0 && dispMult > 0) continue;

    // Look forward for an impulsive move that displaces dispMult × ATR
    // in the OPPOSITE direction of c.
    for (let k = i + 1; k <= Math.min(i + lookForward, endIdx); k++) {
      const fwd = candles[k];
      if (isDown) {
        // Need an impulsive UP move — confirms a bullish OB at candle i
        const moveUp = fwd.high - c.low;
        if (moveUp >= dispMult * localAtr) {
          out.push(makeOb(candles, i, true, moveUp, endIdx));
          break;
        }
      } else {
        // isUp — looking for impulsive DOWN move (bearish OB)
        const moveDown = c.high - fwd.low;
        if (moveDown >= dispMult * localAtr) {
          out.push(makeOb(candles, i, false, moveDown, endIdx));
          break;
        }
      }
    }
  }

  return out;
}

/**
 * Returns the most recent unmitigated OB supporting the given side.
 */
export function nearestUnmitigatedOb(
  candles: BacktestCandle[],
  side: 'BUY' | 'SELL',
  options: DetectObOptions = {},
): OrderBlock | null {
  const all = detectOrderBlocks(candles, options);
  const wantBullish = side === 'BUY';
  for (let i = all.length - 1; i >= 0; i--) {
    const ob = all[i];
    if (ob.mitigated) continue;
    if (ob.isBullish !== wantBullish) continue;
    return ob;
  }
  return null;
}

/**
 * Gate: entry must be inside or within `maxDistanceAtr` of an
 * unmitigated, direction-aligned OB.
 */
export function hasSupportingOb(
  candles: BacktestCandle[],
  side: 'BUY' | 'SELL',
  entryPrice: number,
  maxDistanceAtr: number,
  atr: number[],
  endIdx: number,
): { ok: true; ob: OrderBlock } | { ok: false } {
  const ob = nearestUnmitigatedOb(candles, side, { endIdx, atr });
  if (!ob) return { ok: false };

  const inside = entryPrice >= ob.bottom && entryPrice <= ob.top;
  if (inside) return { ok: true, ob };

  const localAtr = atr[endIdx] ?? 0;
  if (localAtr <= 0) return { ok: true, ob };
  const distance = entryPrice > ob.top ? entryPrice - ob.top : ob.bottom - entryPrice;
  if (distance <= maxDistanceAtr * localAtr) return { ok: true, ob };

  return { ok: false };
}

// ─── internals ───────────────────────────────────────────────────────────

function makeOb(
  candles: BacktestCandle[],
  candleIdx: number,
  isBullish: boolean,
  displacement: number,
  endIdx: number,
): OrderBlock {
  const c = candles[candleIdx];
  // OB zone is the candle's body span (open ↔ close) for tighter zones,
  // or the full range (high ↔ low) for looser ones. We use the full
  // range — tighter zones miss too many retests.
  const ob: OrderBlock = {
    top: c.high,
    bottom: c.low,
    candleTime: c.openTime,
    candleIdx,
    isBullish,
    displacement,
    mitigated: false,
    mitigatedAtIdx: -1,
  };
  // Mitigation: price re-enters the OB zone after the impulsive move.
  // We check for any subsequent wick into the zone.
  for (let k = candleIdx + 2; k <= endIdx; k++) {
    const f = candles[k];
    if (isBullish) {
      // Bullish OB at low region — mitigated when price wicks back DOWN to it
      if (f.low <= ob.top) {
        ob.mitigated = true;
        ob.mitigatedAtIdx = k;
        break;
      }
    } else {
      if (f.high >= ob.bottom) {
        ob.mitigated = true;
        ob.mitigatedAtIdx = k;
        break;
      }
    }
  }
  return ob;
}
