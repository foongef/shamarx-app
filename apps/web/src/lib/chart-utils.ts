import type { BacktestTrade } from './types';

export interface EquityPoint {
  time: string;
  value: number;
}

export interface DrawdownPoint {
  time: string;
  value: number;
}

export function computeEquityCurve(
  trades: BacktestTrade[],
  initialBalance: number,
): EquityPoint[] {
  const sorted = [...trades].sort(
    (a, b) => new Date(a.exitTime).getTime() - new Date(b.exitTime).getTime(),
  );

  const points: EquityPoint[] = [
    { time: sorted[0]?.entryTime?.split('T')[0] ?? '', value: initialBalance },
  ];

  let balance = initialBalance;
  for (const trade of sorted) {
    balance += trade.pnl;
    points.push({
      time: trade.exitTime.split('T')[0],
      value: balance,
    });
  }

  return points;
}

export function computeDrawdownSeries(
  trades: BacktestTrade[],
  initialBalance: number,
): DrawdownPoint[] {
  const sorted = [...trades].sort(
    (a, b) => new Date(a.exitTime).getTime() - new Date(b.exitTime).getTime(),
  );

  const points: DrawdownPoint[] = [
    { time: sorted[0]?.entryTime?.split('T')[0] ?? '', value: 0 },
  ];

  let balance = initialBalance;
  let peak = initialBalance;

  for (const trade of sorted) {
    balance += trade.pnl;
    if (balance > peak) peak = balance;
    const drawdownPct = ((balance - peak) / peak) * 100;
    points.push({
      time: trade.exitTime.split('T')[0],
      value: drawdownPct,
    });
  }

  return points;
}
