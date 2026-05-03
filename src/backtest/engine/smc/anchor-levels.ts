/**
 * Anchor liquidity levels — PDH/PDL, Asian Range H/L, Weekly H/L.
 *
 * Real SMC traders treat these specific session-derived levels as the actual
 * liquidity pools (where retail stop-orders cluster). Random H1 swings are
 * noise on macro pairs like EURUSD; only anchor levels carry institutional
 * interest.
 *
 * This module is pure / stateless — it inspects raw H1 candles and returns
 * the active anchor levels at a given time. Used by sweep-detector when the
 * pair config has `useAnchorSweeps: true`.
 *
 * Step 4.1 ships PDH/PDL only. Steps 4.3+ extend to Asian / Weekly.
 */
import { BacktestCandle } from '../types';

export interface AnchorLevels {
  /** Previous trading day high (yesterday's UTC high). */
  pdh: number | null;
  /** Previous trading day low. */
  pdl: number | null;
  /** Asian session high (today's 22:00 UTC prior day → 06:00 UTC today). */
  asianHigh: number | null;
  /** Asian session low. */
  asianLow: number | null;
  /** Last week's UTC high (Mon-Fri prior week). */
  weeklyHigh: number | null;
  /** Last week's UTC low. */
  weeklyLow: number | null;
}

/**
 * Compute anchor levels active at the given time.
 *
 * For PDH/PDL we walk back through H1 candles to assemble yesterday's
 * UTC range. "Yesterday" = the calendar day immediately before the UTC
 * day of `currentTime`.
 *
 * Returns null fields if there isn't enough lookback history (e.g. very
 * start of the dataset, holiday gaps).
 */
export function getAnchorLevels(
  h1Candles: BacktestCandle[],
  currentTime: string,
): AnchorLevels {
  const t = new Date(currentTime);
  const tMs = t.getTime();

  // ── PDH/PDL — yesterday's UTC high/low ────────────────────────────────
  const yesterday = new Date(t);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yKey = yesterday.toISOString().slice(0, 10);
  let pdh = -Infinity, pdl = Infinity, foundPd = false;

  // ── Asian range — 22:00 UTC (prior day) → 06:00 UTC (current day) ─────
  // Anchor relevant for London-open sweep plays.
  const asianStart = new Date(t);
  asianStart.setUTCHours(0, 0, 0, 0);
  asianStart.setUTCDate(asianStart.getUTCDate() - 1);
  asianStart.setUTCHours(22, 0, 0, 0);
  const asianEnd = new Date(t);
  asianEnd.setUTCHours(6, 0, 0, 0);
  let asianHigh = -Infinity, asianLow = Infinity, foundAsian = false;

  // ── Weekly H/L — last calendar week (Mon→Fri prior to current week) ───
  // Find Monday 00:00 UTC of CURRENT week, subtract 7 days for prior week start
  const dow = t.getUTCDay(); // 0=Sun
  const daysSinceMonday = (dow + 6) % 7; // Mon=0
  const thisWeekStart = new Date(t);
  thisWeekStart.setUTCHours(0, 0, 0, 0);
  thisWeekStart.setUTCDate(thisWeekStart.getUTCDate() - daysSinceMonday);
  const lastWeekStart = new Date(thisWeekStart);
  lastWeekStart.setUTCDate(lastWeekStart.getUTCDate() - 7);
  const lastWeekStartMs = lastWeekStart.getTime();
  const thisWeekStartMs = thisWeekStart.getTime();
  let weeklyHigh = -Infinity, weeklyLow = Infinity, foundWeek = false;

  // Single reverse pass through H1 candles, fanning out to all anchors
  for (let i = h1Candles.length - 1; i >= 0; i--) {
    const c = h1Candles[i];
    const candleTime = new Date(c.openTime).getTime();
    if (candleTime >= tMs) continue; // skip future

    // PDH/PDL — yesterday only
    const candleDay = c.openTime.slice(0, 10);
    if (candleDay === yKey) {
      foundPd = true;
      if (c.high > pdh) pdh = c.high;
      if (c.low < pdl) pdl = c.low;
    }

    // Asian range — within [asianStart, asianEnd)
    if (candleTime >= asianStart.getTime() && candleTime < asianEnd.getTime()) {
      foundAsian = true;
      if (c.high > asianHigh) asianHigh = c.high;
      if (c.low < asianLow) asianLow = c.low;
    }

    // Weekly — last week's bars
    if (candleTime >= lastWeekStartMs && candleTime < thisWeekStartMs) {
      foundWeek = true;
      if (c.high > weeklyHigh) weeklyHigh = c.high;
      if (c.low < weeklyLow) weeklyLow = c.low;
    }

    // Early-out: once we're 9 days back, all anchors are stale
    if (candleTime < lastWeekStartMs - 86400000 * 2) break;
  }

  return {
    pdh: foundPd ? pdh : null,
    pdl: foundPd ? pdl : null,
    asianHigh: foundAsian ? asianHigh : null,
    asianLow: foundAsian ? asianLow : null,
    weeklyHigh: foundWeek ? weeklyHigh : null,
    weeklyLow: foundWeek ? weeklyLow : null,
  };
}

/**
 * Buffer + tolerance helpers — when checking whether a sweep wick "hit" an
 * anchor, we allow a small ATR-fraction tolerance so price doesn't need to
 * exactly tag the level.
 */
export function withinTolerance(
  price: number,
  level: number,
  toleranceAtr: number,
  atr: number,
): boolean {
  return Math.abs(price - level) <= toleranceAtr * atr;
}
