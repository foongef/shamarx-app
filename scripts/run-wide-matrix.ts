/**
 * Wide matrix: V6-alt × 2 pairs × 5 accounts × 4 periods = 40 cells.
 * Uses 90-day HTF warm-up (matches production NestJS service).
 * Output: reports/wide-matrix.json
 */
import 'reflect-metadata';
import { writeFileSync, mkdirSync } from 'fs';
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
const PAIRS = ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY'];
const ACCOUNTS = [100, 500, 1000, 2000, 10000];
const RISK = 1.5;

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

function htfStart(start: string, days = 90): string {
  const d = new Date(start);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

interface Cell {
  pair: string; period: string; account: number;
  trades: number; tradesPerMonth: number; winRate: number;
  returnPct: number; pf: number; sharpe: number; maxDD: number;
  totalPnl: number; finalBalance: number; avgRR: number;
  totalCommission: number;
}

async function main() {
  const cells: Cell[] = [];

  for (const period of PERIODS) {
    console.log(`\n=== ${period.label} ===`);
    // pre-fetch candles per pair (reused across accounts)
    const data: Record<string, { m15: BacktestCandle[]; h1: BacktestCandle[]; h4: BacktestCandle[]; d1: BacktestCandle[]; months: number }> = {};
    for (const pair of PAIRS) {
      const m15 = await fetchCandles(pair, 'M15', period.start, period.end);
      const hStart = htfStart(period.start);
      const h1 = await fetchCandles(pair, 'H1', hStart, period.end);
      const h4 = await fetchCandles(pair, 'H4', hStart, period.end);
      const d1 = await fetchCandles(pair, 'D1', hStart, period.end);
      const months = Math.max(1, (Date.parse(period.end) - Date.parse(period.start)) / (1000 * 60 * 60 * 24 * 30));
      data[pair] = { m15, h1, h4, d1, months };
    }

    for (const pair of PAIRS) {
      for (const account of ACCOUNTS) {
        const cfg: EngineConfig = {
          symbol: pair,
          initialBalance: account,
          riskPercent: RISK,
          maxDailyLossPercent: 4.0,
          maxConsecutiveLosses: 5,
          maxOpenPositions: 4,
          strategyVersion: 'V6-alt',
        };
        const engine = new BacktestEngine();
        const r = engine.run(data[pair].m15, data[pair].h1, cfg, { h4Candles: data[pair].h4, d1Candles: data[pair].d1 });
        const m = r.metrics;
        const tpm = m.totalTrades / data[pair].months;
        cells.push({
          pair, period: period.label, account,
          trades: m.totalTrades,
          tradesPerMonth: Math.round(tpm * 10) / 10,
          winRate: m.winRate,
          returnPct: m.returnPercent,
          pf: m.profitFactor,
          sharpe: m.sharpeRatio,
          maxDD: m.maxDrawdownPercent,
          totalPnl: m.totalPnl,
          finalBalance: m.finalBalance,
          avgRR: m.avgRR,
          totalCommission: m.totalCommission,
        });
        console.log(
          `  ${pair} $${String(account).padStart(5)}  ` +
          `t=${String(m.totalTrades).padStart(3)} (${tpm.toFixed(1)}/mo) ` +
          `win=${String(m.winRate).padStart(5)}% ` +
          `ret=${(m.returnPercent >= 0 ? '+' : '') + m.returnPercent.toFixed(1)}% ` +
          `PF=${m.profitFactor} Sharpe=${m.sharpeRatio} DD=${m.maxDrawdownPercent}%`,
        );
      }
    }
  }

  const outDir = join(__dirname, '..', 'reports');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'wide-matrix.json'), JSON.stringify(cells, null, 2));
  console.log(`\nWrote reports/wide-matrix.json (${cells.length} cells)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
