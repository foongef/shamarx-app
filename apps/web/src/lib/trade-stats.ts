/**
 * Pure helpers that derive analytics from a list of closed trades.
 * No React, no fetching — these run in any context.
 */
import type { BacktestTrade } from './types';

export interface EquityPoint {
  time: number; // unix seconds
  equity: number;
  drawdown: number; // 0..1, inverted curve (positive)
  trade?: BacktestTrade;
}

export function buildEquityCurve(
  trades: BacktestTrade[],
  startBalance: number,
): EquityPoint[] {
  const sorted = [...trades].sort(
    (a, b) =>
      new Date(a.exitTime).getTime() - new Date(b.exitTime).getTime(),
  );
  let bal = startBalance;
  let peak = startBalance;
  // Build raw points first; then collapse same-timestamp points so
  // lightweight-charts doesn't silently reject the series. Multiple trades
  // closing on the same M15 candle (very common with V6-alt's TP1 + Runner
  // split orders) would otherwise produce duplicate timestamps.
  const raw: EquityPoint[] = [
    {
      time: sorted.length > 0
        ? Math.floor(new Date(sorted[0].entryTime).getTime() / 1000)
        : Math.floor(Date.now() / 1000),
      equity: startBalance,
      drawdown: 0,
    },
  ];
  for (const t of sorted) {
    bal += t.pnl;
    if (bal > peak) peak = bal;
    const dd = peak > 0 ? (peak - bal) / peak : 0;
    raw.push({
      time: Math.floor(new Date(t.exitTime).getTime() / 1000),
      equity: bal,
      drawdown: dd,
      trade: t,
    });
  }

  // Collapse duplicate timestamps — keep the LAST point at each second.
  const byTime = new Map<number, EquityPoint>();
  for (const p of raw) byTime.set(p.time, p);
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

export function rMultiple(t: BacktestTrade): number {
  const risk = Math.abs(t.entryPrice - t.slPrice);
  if (risk === 0) return 0;
  const move = Math.abs(t.exitPrice - t.entryPrice);
  return t.pnl >= 0 ? move / risk : -(move / risk);
}

export interface RBucket {
  label: string;
  range: [number, number];
  count: number;
}

export function rDistribution(trades: BacktestTrade[]): RBucket[] {
  const buckets: RBucket[] = [
    { label: '< -2', range: [-Infinity, -2], count: 0 },
    { label: '-2..-1', range: [-2, -1], count: 0 },
    { label: '-1..0', range: [-1, 0], count: 0 },
    { label: '0..1', range: [0, 1], count: 0 },
    { label: '1..2', range: [1, 2], count: 0 },
    { label: '2..3', range: [2, 3], count: 0 },
    { label: '> 3', range: [3, Infinity], count: 0 },
  ];
  for (const t of trades) {
    const r = rMultiple(t);
    const b = buckets.find((b) => r >= b.range[0] && r < b.range[1]);
    if (b) b.count++;
  }
  return buckets;
}

export interface MonthCell {
  year: number;
  month: number; // 0..11
  pnl: number;
  trades: number;
  returnPct: number; // pnl / equityAtMonthStart
}

export function monthlyReturns(
  trades: BacktestTrade[],
  startBalance: number,
): MonthCell[] {
  const sorted = [...trades].sort(
    (a, b) =>
      new Date(a.exitTime).getTime() - new Date(b.exitTime).getTime(),
  );
  const map = new Map<string, { pnl: number; trades: number; bal: number }>();
  let runningBal = startBalance;
  let monthStartBal = startBalance;
  let currentKey = '';
  for (const t of sorted) {
    const d = new Date(t.exitTime);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    if (key !== currentKey) {
      monthStartBal = runningBal;
      currentKey = key;
    }
    runningBal += t.pnl;
    const cell = map.get(key) ?? { pnl: 0, trades: 0, bal: monthStartBal };
    cell.pnl += t.pnl;
    cell.trades += 1;
    cell.bal = monthStartBal;
    map.set(key, cell);
  }
  return Array.from(map.entries())
    .map(([k, v]) => {
      const [y, m] = k.split('-').map(Number);
      return {
        year: y,
        month: m,
        pnl: v.pnl,
        trades: v.trades,
        returnPct: v.bal > 0 ? (v.pnl / v.bal) * 100 : 0,
      };
    })
    .sort((a, b) => (a.year - b.year) * 12 + (a.month - b.month));
}

export interface DayCell {
  date: string; // YYYY-MM-DD (UTC)
  pnl: number;
  trades: number;
  returnPct: number; // pnl / equityAtDayStart * 100
}

/**
 * Build a per-trading-day PnL series with running equity. Days with no
 * trades produce no entry — the consumer fills the calendar grid.
 */
export function dailyPnL(
  trades: BacktestTrade[],
  startBalance: number,
): DayCell[] {
  const sorted = [...trades].sort(
    (a, b) =>
      new Date(a.exitTime).getTime() - new Date(b.exitTime).getTime(),
  );
  const map = new Map<string, { pnl: number; trades: number; bal: number }>();
  let runningBal = startBalance;
  let dayStartBal = startBalance;
  let currentDay = '';
  for (const t of sorted) {
    const day = t.exitTime.slice(0, 10);
    if (day !== currentDay) {
      dayStartBal = runningBal;
      currentDay = day;
    }
    runningBal += t.pnl;
    const cell = map.get(day) ?? { pnl: 0, trades: 0, bal: dayStartBal };
    cell.pnl += t.pnl;
    cell.trades += 1;
    cell.bal = dayStartBal;
    map.set(day, cell);
  }
  return Array.from(map.entries())
    .map(([date, v]) => ({
      date,
      pnl: v.pnl,
      trades: v.trades,
      returnPct: v.bal > 0 ? (v.pnl / v.bal) * 100 : 0,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function exitReasonBreakdown(trades: BacktestTrade[]) {
  const map = new Map<string, { count: number; pnl: number }>();
  for (const t of trades) {
    const cell = map.get(t.exitReason) ?? { count: 0, pnl: 0 };
    cell.count++;
    cell.pnl += t.pnl;
    map.set(t.exitReason, cell);
  }
  return Array.from(map.entries()).map(([reason, v]) => ({
    reason,
    count: v.count,
    pnl: v.pnl,
    ratio: trades.length > 0 ? v.count / trades.length : 0,
  }));
}

export function setupTagAttribution(trades: BacktestTrade[]) {
  const map = new Map<string, { count: number; wins: number; pnl: number }>();
  for (const t of trades) {
    for (const tag of t.setupTags ?? []) {
      const cell = map.get(tag) ?? { count: 0, wins: 0, pnl: 0 };
      cell.count++;
      if (t.pnl > 0) cell.wins++;
      cell.pnl += t.pnl;
      map.set(tag, cell);
    }
  }
  return Array.from(map.entries())
    .map(([tag, v]) => ({
      tag,
      count: v.count,
      winRate: v.count > 0 ? (v.wins / v.count) * 100 : 0,
      pnl: v.pnl,
    }))
    .sort((a, b) => b.count - a.count);
}
