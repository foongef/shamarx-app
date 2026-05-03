/**
 * Baseline + iteration A/B harness.
 * Runs XAUUSD + EURUSD V6-alt at $1k/1.5% across 4 periods.
 * Tagged with a label so we can diff iterations.
 *
 * Usage:
 *   pnpm exec ts-node -P tsconfig.build.json --transpile-only scripts/run-baseline.ts <label>
 *   e.g. ./scripts/run-baseline.ts iter0-baseline
 */
import 'reflect-metadata';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { BacktestEngine } from '../src/backtest/engine/backtest-engine';
import { BacktestCandle, EngineConfig } from '../src/backtest/engine/types';

const EXEC_URL = process.env.EXECUTION_SERVICE_URL ?? 'http://localhost:8000';
const PERIODS = [
  { label: '2023', start: '2023-01-15', end: '2023-12-31' },
  { label: '2024', start: '2024-01-01', end: '2024-12-31' },
  { label: '2025', start: '2025-01-01', end: '2025-12-31' },
  { label: '2026-YTD', start: '2026-01-01', end: '2026-04-30' },
];
const PAIRS = ['XAUUSD', 'EURUSD'];

async function fetchCandles(symbol: string, tf: string, start: string, end: string): Promise<BacktestCandle[]> {
  const url = `${EXEC_URL}/historical-candles?symbol=${symbol}&timeframe=${tf}&start=${start}&end=${end}`;
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${tf} ${start}: ${r.status}`);
      return (await r.json()) as BacktestCandle[];
    } catch (e) { if (a === 3) throw e; await new Promise((res) => setTimeout(res, 500 * (a + 1))); }
  }
  return [];
}

/**
 * Apply 90-day HTF warmup window to match the production NestJS service.
 * Without this, indicators are NaN for the first ~50 days and results are
 * unfairly inflated.
 */
function htfStart(start: string, days = 90): string {
  const d = new Date(start);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

interface Cell {
  pair: string;
  period: string;
  trades: number;
  winRate: number;
  returnPct: number;
  pf: number;
  sharpe: number;
  maxDD: number;
  totalPnl: number;
  totalCommission: number;
}

async function main() {
  const label = process.argv[2] ?? 'unlabeled';
  console.log(`\n=== Iteration: ${label} ===\n`);

  const cells: Cell[] = [];
  for (const pair of PAIRS) {
    for (const period of PERIODS) {
      const m15 = await fetchCandles(pair, 'M15', period.start, period.end);
      const hStart = htfStart(period.start);
      const h1 = await fetchCandles(pair, 'H1', hStart, period.end);
      const h4 = await fetchCandles(pair, 'H4', hStart, period.end);
      const d1 = await fetchCandles(pair, 'D1', hStart, period.end);

      if (m15.length < 200) {
        console.log(`  ${pair} ${period.label}: insufficient data, skipped`);
        continue;
      }

      const cfg: EngineConfig = {
        symbol: pair,
        initialBalance: 1000,
        riskPercent: 1.5,
        maxDailyLossPercent: 4.0,
        maxConsecutiveLosses: 5,
        maxOpenPositions: 4,
        strategyVersion: 'V6-alt',
      };
      const engine = new BacktestEngine();
      const result = engine.run(m15, h1, cfg, { h4Candles: h4, d1Candles: d1 });
      const m = result.metrics;
      const cell: Cell = {
        pair,
        period: period.label,
        trades: m.totalTrades,
        winRate: m.winRate,
        returnPct: m.returnPercent,
        pf: m.profitFactor,
        sharpe: m.sharpeRatio,
        maxDD: m.maxDrawdownPercent,
        totalPnl: m.totalPnl,
        totalCommission: m.totalCommission,
      };
      cells.push(cell);
      console.log(
        `  ${pair} ${period.label.padEnd(9)} ` +
        `t=${String(m.totalTrades).padStart(3)} ` +
        `win=${String(m.winRate).padStart(5)}% ` +
        `ret=${(m.returnPercent >= 0 ? '+' : '') + m.returnPercent.toFixed(1)}% ` +
        `PF=${m.profitFactor} ` +
        `Sharpe=${m.sharpeRatio} ` +
        `DD=${m.maxDrawdownPercent}%`,
      );
    }
  }

  const outDir = join(__dirname, '..', 'reports', 'iterations');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, `${label}.json`),
    JSON.stringify({ label, ranAt: new Date().toISOString(), cells }, null, 2),
  );
  console.log(`\nWrote reports/iterations/${label}.json`);

  // If a previous label is given, diff
  const compareTo = process.argv[3];
  if (compareTo) {
    const prevPath = join(outDir, `${compareTo}.json`);
    if (existsSync(prevPath)) {
      const prev = JSON.parse(readFileSync(prevPath, 'utf-8'));
      console.log(`\n=== Δ vs ${compareTo} ===`);
      for (const c of cells) {
        const p = prev.cells.find((x: Cell) => x.pair === c.pair && x.period === c.period);
        if (!p) continue;
        const dRet = c.returnPct - p.returnPct;
        const dPF = c.pf - p.pf;
        const dDD = c.maxDD - p.maxDD;
        const dT = c.trades - p.trades;
        const sign = (n: number) => (n >= 0 ? '+' : '');
        console.log(
          `  ${c.pair} ${c.period.padEnd(9)} ` +
          `Δret=${sign(dRet)}${dRet.toFixed(1)}%  ` +
          `Δpf=${sign(dPF)}${dPF.toFixed(2)}  ` +
          `Δdd=${sign(dDD)}${dDD.toFixed(1)}%  ` +
          `Δt=${sign(dT)}${dT}`,
        );
      }
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
