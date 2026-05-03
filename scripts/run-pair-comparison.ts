/**
 * Pair-agnostic comparison matrix runner.
 * Runs V5.5b + V6 + V6-alt across 5 account sizes × 4 periods for the given SYMBOL.
 *
 * Usage:
 *   SYMBOL=EURUSD pnpm exec ts-node -P tsconfig.build.json --transpile-only scripts/run-pair-comparison.ts
 */
import 'reflect-metadata';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { BacktestEngine } from '../src/backtest/engine/backtest-engine';
import { BacktestCandle, EngineConfig, StrategyVersion } from '../src/backtest/engine/types';

const EXEC_URL = process.env.EXECUTION_SERVICE_URL ?? 'http://localhost:8000';
const SYMBOL = process.env.SYMBOL ?? 'XAUUSD';

const PERIODS = [
  { label: '2023', start: '2023-01-15', end: '2023-12-31' },
  { label: '2024', start: '2024-01-01', end: '2024-12-31' },
  { label: '2025', start: '2025-01-01', end: '2025-12-31' },
  { label: '2026-YTD', start: '2026-01-01', end: '2026-04-30' },
];

const STRATEGIES: { name: StrategyVersion; risk: number }[] = [
  { name: 'V5.5b', risk: 3.0 },
  { name: 'V6',     risk: 3.0 },
  { name: 'V6-alt', risk: 1.5 },
];

const ACCOUNTS = [100, 500, 1000, 2000, 10000];

async function fetchCandles(tf: string, start: string, end: string): Promise<BacktestCandle[]> {
  const url = `${EXEC_URL}/historical-candles?symbol=${SYMBOL}&timeframe=${tf}&start=${start}&end=${end}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`fetch ${tf} ${start}→${end}: ${r.status}`);
      return (await r.json()) as BacktestCandle[];
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
    }
  }
  return [];
}

interface Cell {
  strategy: StrategyVersion;
  account: number;
  period: string;
  trades: number;
  tradesPerMonth: number;
  winRate: number;
  profitFactor: number;
  returnPercent: number;
  finalBalance: number;
  maxDrawdownPercent: number;
  sharpeRatio: number;
  avgRR: number;
}

async function main() {
  console.log(`\n=== Pair: ${SYMBOL} ===\n`);
  const all: Cell[] = [];

  for (const period of PERIODS) {
    console.log(`\n--- ${period.label} (${period.start} → ${period.end}) ---`);
    const m15 = await fetchCandles('M15', period.start, period.end);
    const h1 = await fetchCandles('H1', period.start, period.end);
    const h4 = await fetchCandles('H4', period.start, period.end);
    const d1 = await fetchCandles('D1', period.start, period.end);
    if (m15.length < 200) {
      console.log(`Skipping ${period.label} — insufficient M15 data (${m15.length})`);
      continue;
    }
    const months = Math.max(1, (Date.parse(period.end) - Date.parse(period.start)) / (1000 * 60 * 60 * 24 * 30));

    for (const strat of STRATEGIES) {
      for (const account of ACCOUNTS) {
        const cfg: EngineConfig = {
          symbol: SYMBOL,
          initialBalance: account,
          riskPercent: strat.risk,
          maxDailyLossPercent: 4.0,
          maxConsecutiveLosses: 5,
          maxOpenPositions: 4,
          strategyVersion: strat.name,
        };
        const engine = new BacktestEngine();
        const result = engine.run(m15, h1, cfg, { h4Candles: h4, d1Candles: d1 });
        const m = result.metrics;
        const tpm = m.totalTrades / months;
        all.push({
          strategy: strat.name, account, period: period.label,
          trades: m.totalTrades,
          tradesPerMonth: Math.round(tpm * 10) / 10,
          winRate: m.winRate,
          profitFactor: m.profitFactor,
          returnPercent: m.returnPercent,
          finalBalance: m.finalBalance,
          maxDrawdownPercent: m.maxDrawdownPercent,
          sharpeRatio: m.sharpeRatio,
          avgRR: m.avgRR,
        });
        console.log(
          `  ${strat.name.padEnd(7)} $${String(account).padStart(5)}  ` +
          `trades=${String(m.totalTrades).padStart(3)} (${tpm.toFixed(1)}/mo)  ` +
          `win=${String(m.winRate).padStart(5)}%  pnl=${(m.returnPercent>=0?'+':'')+m.returnPercent.toFixed(1)}%  ` +
          `dd=${m.maxDrawdownPercent}%  Sharpe=${m.sharpeRatio}  PF=${m.profitFactor}`,
        );
      }
    }
  }

  const outDir = join(__dirname, '..', 'reports');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${SYMBOL.toLowerCase()}-comparison.json`), JSON.stringify(all, null, 2));
  console.log(`\nWrote reports/${SYMBOL.toLowerCase()}-comparison.json (${all.length} cells)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
