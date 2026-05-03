import type { BacktestRun, StrategyVersion } from './types';

export interface StrategyAggregate {
  strategy: StrategyVersion;
  runs: number;
  totalTrades: number;
  avgReturn: number;
  bestReturn: number;
  worstReturn: number;
  avgWinRate: number;
  avgPF: number;
  avgDD: number;
  totalPnL: number;
}

/** Strategy short blurbs that are stable enough to live in the UI. */
export const STRATEGY_META: Record<StrategyVersion, {
  blurb: string;
  description: string;
  hue: string;
}> = {
  'V5.5b': {
    blurb: 'Conservative trend pullback baseline',
    description:
      'EMA-pullback with strict ADX gate, FVG fill engine, and the legacy range engine. Selective on real data — fewer trades, very high win-rate when it does fire.',
    hue: 'text-strat-v5',
  },
  'V6': {
    blurb: 'Multi-engine trend with HTF confluence',
    description:
      'Adds D1 confluence, BB-reversal, EMA-cross retest, and momentum continuation engines. Higher trade frequency — pulls activity into low-ADX years.',
    hue: 'text-strat-v6',
  },
  'V6-alt': {
    blurb: 'Smart-money concepts, sweep + reverse / continuation',
    description:
      'Greenfield SMC engine. H1 liquidity sweep with D1-ADX-based mode flip (continuation if trending, reversal if ranging). The strongest performer on real Dukascopy.',
    hue: 'text-strat-v6alt',
  },
};

export function strategyOf(run: BacktestRun): StrategyVersion {
  // backend may not always include strategyVersion — default to V5.5b for legacy runs
  return (run.strategyVersion as StrategyVersion) ?? 'V5.5b';
}

export function buildStrategyAggregates(
  runs: BacktestRun[],
): StrategyAggregate[] {
  const completed = runs.filter((r) => r.status === 'COMPLETED' && r.metrics);
  const groups = new Map<StrategyVersion, BacktestRun[]>();
  for (const r of completed) {
    const k = strategyOf(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  const out: StrategyAggregate[] = [];
  (['V5.5b', 'V6', 'V6-alt'] as StrategyVersion[]).forEach((s) => {
    const list = groups.get(s) ?? [];
    if (list.length === 0) {
      out.push({
        strategy: s,
        runs: 0,
        totalTrades: 0,
        avgReturn: 0,
        bestReturn: 0,
        worstReturn: 0,
        avgWinRate: 0,
        avgPF: 0,
        avgDD: 0,
        totalPnL: 0,
      });
      return;
    }
    const returns = list.map((r) => r.metrics?.returnPercent ?? 0);
    const trades = list.reduce((s, r) => s + (r.metrics?.totalTrades ?? 0), 0);
    const wr = list.reduce((s, r) => s + (r.metrics?.winRate ?? 0), 0) / list.length;
    const pfs = list.map((r) => r.metrics?.profitFactor ?? 0).filter((n) => Number.isFinite(n));
    const pf = pfs.length ? pfs.reduce((s, n) => s + n, 0) / pfs.length : 0;
    const dd = list.reduce((s, r) => s + (r.metrics?.maxDrawdownPercent ?? 0), 0) / list.length;
    const pnl = list.reduce((s, r) => s + (r.metrics?.totalPnl ?? 0), 0);
    out.push({
      strategy: s,
      runs: list.length,
      totalTrades: trades,
      avgReturn: returns.reduce((s, n) => s + n, 0) / returns.length,
      bestReturn: Math.max(...returns),
      worstReturn: Math.min(...returns),
      avgWinRate: wr,
      avgPF: pf,
      avgDD: dd,
      totalPnL: pnl,
    });
  });
  return out;
}

/**
 * Build a fake equity curve from initialBalance + final metrics — purely for
 * sparklines when we don't have per-trade equity data inline. Generates a
 * plausible monotonic-ish curve seeded by the run id.
 */
export function syntheticEquityCurve(run: BacktestRun, n = 32): number[] {
  if (!run.metrics) {
    return Array(n).fill(run.initialBalance);
  }
  const start = run.initialBalance;
  const end = run.metrics.finalBalance;
  const seed = [...run.id].reduce((s, c) => s + c.charCodeAt(0), 0);
  const noise = (i: number) => {
    const x = Math.sin(seed * (i + 1)) * 10000;
    return (x - Math.floor(x)) - 0.5; // [-0.5, 0.5]
  };
  const dd = run.metrics.maxDrawdownPercent / 100;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const trend = start + (end - start) * t;
    // Inject one drawdown valley around 35-65% of the period
    const valleyT = 0.35 + 0.3 * (Math.abs(noise(0)));
    const valleyDepth = dd * Math.max(0, 1 - Math.abs(t - valleyT) * 6);
    const wiggle = noise(i) * Math.max(start, end) * 0.015;
    out.push(trend - trend * valleyDepth + wiggle);
  }
  return out;
}
