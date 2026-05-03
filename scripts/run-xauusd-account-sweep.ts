/**
 * XAUUSD V6-alt account-size sweep.
 * Runs the SMC engine across $100, $500, $1k, $2k, $10k for 2023, 2024, 2025, 2026-YTD.
 * Writes results to reports/xauusd-account-sweep.json + .md.
 */
import 'reflect-metadata';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { BacktestEngine } from '../src/backtest/engine/backtest-engine';
import { BacktestCandle, EngineConfig } from '../src/backtest/engine/types';

const EXEC_URL = process.env.EXECUTION_SERVICE_URL ?? 'http://localhost:8000';
const SYMBOL = 'XAUUSD';
const RISK = 1.5;

const PERIODS = [
  { label: '2023', start: '2023-01-15', end: '2023-12-31' },
  { label: '2024', start: '2024-01-01', end: '2024-12-31' },
  { label: '2025', start: '2025-01-01', end: '2025-12-31' },
  { label: '2026-YTD', start: '2026-01-01', end: '2026-04-30' },
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
  account: number;
  period: string;
  trades: number;
  tradesPerMonth: number;
  winRate: number;
  profitFactor: number;
  returnPercent: number;
  totalPnl: number;
  finalBalance: number;
  maxDrawdownPercent: number;
  sharpeRatio: number;
  avgRR: number;
  maxConsecutiveLosses: number;
}

async function main() {
  const allCells: Cell[] = [];

  for (const period of PERIODS) {
    console.log(`\n=== ${period.label} ===`);
    const m15 = await fetchCandles('M15', period.start, period.end);
    const h1 = await fetchCandles('H1', period.start, period.end);
    const h4 = await fetchCandles('H4', period.start, period.end);
    const d1 = await fetchCandles('D1', period.start, period.end);
    const months = Math.max(1, (Date.parse(period.end) - Date.parse(period.start)) / (1000 * 60 * 60 * 24 * 30));

    for (const account of ACCOUNTS) {
      const cfg: EngineConfig = {
        symbol: SYMBOL,
        initialBalance: account,
        riskPercent: RISK,
        maxDailyLossPercent: 4.0,
        maxConsecutiveLosses: 5,
        maxOpenPositions: 4,
        strategyVersion: 'V6-alt',
      };
      const engine = new BacktestEngine();
      const result = engine.run(m15, h1, cfg, { h4Candles: h4, d1Candles: d1 });
      const m = result.metrics;
      const tpm = m.totalTrades / months;
      allCells.push({
        account, period: period.label,
        trades: m.totalTrades,
        tradesPerMonth: Math.round(tpm * 10) / 10,
        winRate: m.winRate,
        profitFactor: m.profitFactor,
        returnPercent: m.returnPercent,
        totalPnl: m.totalPnl,
        finalBalance: m.finalBalance,
        maxDrawdownPercent: m.maxDrawdownPercent,
        sharpeRatio: m.sharpeRatio,
        avgRR: m.avgRR,
        maxConsecutiveLosses: m.maxConsecutiveLosses,
      });
      console.log(
        `  $${String(account).padStart(5)}  trades=${String(m.totalTrades).padStart(3)} ` +
        `(${tpm.toFixed(1)}/mo) win=${String(m.winRate).padStart(5)}% ` +
        `pnl=${(m.returnPercent>=0?'+':'')+m.returnPercent.toFixed(1)}% ` +
        `dd=${m.maxDrawdownPercent}% Sharpe=${m.sharpeRatio} PF=${m.profitFactor}`,
      );
    }
  }

  const outDir = join(__dirname, '..', 'reports');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'xauusd-account-sweep.json'), JSON.stringify(allCells, null, 2));
  console.log(`\nWrote reports/xauusd-account-sweep.json (${allCells.length} cells)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
