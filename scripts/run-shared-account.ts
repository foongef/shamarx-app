/**
 * Shared-account portfolio simulation.
 *
 * Runs XAUUSD + EURUSD on the SAME $2k account (shared balance, shared
 * drawdown). Approximates the multi-pair effect by:
 *   1. Running each pair independently to produce a trade list
 *   2. Merging trades chronologically by exitTime
 *   3. Scaling each trade's PnL by (current_balance / starting_balance)
 *      so wins/losses compound on the shared equity curve
 *
 * NOTE: this is an approximation. True accuracy requires a multi-pair engine
 * with shared maxOpenPositions and per-tick balance updates.
 */
import 'reflect-metadata';
import { writeFileSync } from 'fs';
import { BacktestEngine } from '../src/backtest/engine/backtest-engine';
import { BacktestCandle, EngineConfig, ClosedTrade } from '../src/backtest/engine/types';

const EXEC_URL = process.env.EXECUTION_SERVICE_URL ?? 'http://localhost:8000';
const PERIODS = [
  { label: '2023', start: '2023-01-15', end: '2023-12-31' },
  { label: '2024', start: '2024-01-01', end: '2024-12-31' },
  { label: '2025', start: '2025-01-01', end: '2025-12-31' },
  { label: '2026-YTD', start: '2026-01-01', end: '2026-04-30' },
];
const PAIRS = ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY'];
const ACCOUNT = 2000;
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

interface PortfolioStats {
  period: string;
  totalTrades: number;
  perPairTrades: Record<string, number>;
  finalBalance: number;
  returnPct: number;
  maxDD: number;
  totalPnl: number;
  winRate: number;
  pf: number;
  monthlyTrades: number;
}

function simulateShared(tradesByPair: Record<string, ClosedTrade[]>, months: number): PortfolioStats {
  const all: (ClosedTrade & { pair: string })[] = [];
  const perPairTrades: Record<string, number> = {};
  for (const [pair, trades] of Object.entries(tradesByPair)) {
    perPairTrades[pair] = trades.length;
    for (const t of trades) all.push({ ...t, pair });
  }
  all.sort((a, b) => Date.parse(a.exitTime) - Date.parse(b.exitTime));

  let balance = ACCOUNT;
  let peak = ACCOUNT;
  let maxDD = 0;
  let wins = 0, losses = 0;
  let grossWin = 0, grossLoss = 0;
  let totalPnl = 0;

  for (const t of all) {
    // scale the trade's PnL: each pair was simulated assuming starting balance $2k.
    // On the shared account, lot size at trade time would have been (current_balance / $2k) ×
    // the original lot. PnL scales linearly with lot.
    const scale = balance / ACCOUNT;
    const scaledPnl = t.pnl * scale;
    balance += scaledPnl;
    totalPnl += scaledPnl;
    if (scaledPnl > 0) { wins++; grossWin += scaledPnl; }
    else if (scaledPnl < 0) { losses++; grossLoss += Math.abs(scaledPnl); }
    peak = Math.max(peak, balance);
    maxDD = Math.max(maxDD, (peak - balance) / peak);
  }

  return {
    period: '',
    totalTrades: all.length,
    perPairTrades,
    finalBalance: Math.round(balance * 100) / 100,
    returnPct: Math.round((balance / ACCOUNT - 1) * 1000) / 10,
    maxDD: Math.round(maxDD * 1000) / 10,
    totalPnl: Math.round(totalPnl * 100) / 100,
    winRate: Math.round((wins / Math.max(1, wins + losses)) * 1000) / 10,
    pf: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : 0,
    monthlyTrades: Math.round((all.length / months) * 10) / 10,
  };
}

async function main() {
  const out: PortfolioStats[] = [];
  for (const period of PERIODS) {
    console.log(`\n=== ${period.label} (shared $${ACCOUNT}) ===`);
    const months = Math.max(1, (Date.parse(period.end) - Date.parse(period.start)) / (1000 * 60 * 60 * 24 * 30));

    const trades: Record<string, ClosedTrade[]> = {};
    for (const pair of PAIRS) {
      const m15 = await fetchCandles(pair, 'M15', period.start, period.end);
      const hStart = htfStart(period.start);
      const h1 = await fetchCandles(pair, 'H1', hStart, period.end);
      const h4 = await fetchCandles(pair, 'H4', hStart, period.end);
      const d1 = await fetchCandles(pair, 'D1', hStart, period.end);
      const cfg: EngineConfig = {
        symbol: pair,
        initialBalance: ACCOUNT,
        riskPercent: RISK,
        maxDailyLossPercent: 4.0,
        maxConsecutiveLosses: 5,
        maxOpenPositions: 4,
        strategyVersion: 'V6-alt',
      };
      const engine = new BacktestEngine();
      const r = engine.run(m15, h1, cfg, { h4Candles: h4, d1Candles: d1 });
      trades[pair] = r.trades;
      console.log(`  ${pair} solo: ${r.trades.length} trades, ${r.metrics.returnPercent}% return`);
    }

    const stats = simulateShared(trades, months);
    stats.period = period.label;
    out.push(stats);

    const perPairStr = Object.entries(stats.perPairTrades).map(([k, v]) => `${k.slice(0,3)}=${v}`).join(' ');
    console.log(
      `  COMBINED $${ACCOUNT}: ${stats.totalTrades} trades (${stats.monthlyTrades}/mo) ` +
      `[${perPairStr}]  ` +
      `ret=${stats.returnPct >= 0 ? '+' : ''}${stats.returnPct}%  ` +
      `PF=${stats.pf}  win=${stats.winRate}%  DD=${stats.maxDD}%  bal=$${stats.finalBalance}`
    );
  }

  console.log('\n=== Compounded across 4 years ===');
  let bal = ACCOUNT;
  for (const s of out) {
    const r = s.returnPct / 100;
    bal = bal * (1 + r);
    console.log(`  ${s.period}: ${s.returnPct >= 0 ? '+' : ''}${s.returnPct}% → bal $${bal.toFixed(2)}`);
  }
  console.log(`  Total: $${ACCOUNT} → $${bal.toFixed(2)} (${(((bal / ACCOUNT) - 1) * 100).toFixed(1)}%)`);

  writeFileSync('reports/portfolio-2k.json', JSON.stringify(out, null, 2));
  console.log('\nWrote reports/portfolio-2k.json');
}

main().catch((e) => { console.error(e); process.exit(1); });
