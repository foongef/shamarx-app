/**
 * Runs the V5.5b / V6 / V6-alt comparison matrix:
 *   3 strategies × 3 account sizes × 4 periods = 36 backtests
 *
 * Pulls candles once per (symbol, period) and reuses across strategies.
 * Outputs a markdown summary to reports/v6-comparison.md.
 */
import 'reflect-metadata';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { BacktestEngine } from '../src/backtest/engine/backtest-engine';
import { BacktestCandle, EngineConfig, StrategyVersion } from '../src/backtest/engine/types';

const EXEC_URL = process.env.EXECUTION_SERVICE_URL ?? 'http://localhost:8000';
const SYMBOL = 'XAUUSD';

const PERIODS: { label: string; start: string; end: string }[] = [
  { label: '2023', start: '2023-01-15', end: '2023-12-31' }, // skip first 2 weeks for indicator warm-up
  { label: '2024', start: '2024-01-01', end: '2024-12-31' },
  { label: '2025', start: '2025-01-01', end: '2025-12-31' },
  { label: '2026-YTD', start: '2026-01-01', end: '2026-04-30' },
];

const STRATEGIES: { name: StrategyVersion; risk: number }[] = [
  { name: 'V5.5b', risk: 3.0 },
  { name: 'V6',     risk: 3.0 },
  { name: 'V6-alt', risk: 1.5 },  // SMC: bumped 1.0 → 1.5 in round 3
];

const ACCOUNTS = [100, 1000, 10000];

async function fetchCandles(tf: string, start: string, end: string): Promise<BacktestCandle[]> {
  const url = `${EXEC_URL}/historical-candles?symbol=${SYMBOL}&timeframe=${tf}&start=${start}&end=${end}`;
  let lastErr: any;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`fetch ${tf} ${start}→${end} failed: ${r.status}`);
      return (await r.json()) as BacktestCandle[];
    } catch (e) {
      lastErr = e;
      await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

interface CellResult {
  strategy: StrategyVersion;
  account: number;
  period: string;
  trades: number;
  tradesPerMonth: number;
  winRate: number;
  profitFactor: number;
  returnPercent: number;
  maxDrawdownPercent: number;
  sharpeRatio: number;
  finalBalance: number;
  avgRR: number;
  passed: boolean;
}

function evaluate(m: any, account: number, monthsInPeriod: number): boolean {
  const tpm = m.totalTrades / monthsInPeriod;
  return (
    tpm >= 10 &&
    m.profitFactor >= 1.5 &&
    m.sharpeRatio >= 1.0 &&
    m.maxDrawdownPercent <= (account === 100 ? 25 : 20) &&
    m.returnPercent >= 0
  );
}

async function main() {
  const allResults: CellResult[] = [];

  for (const period of PERIODS) {
    console.log(`\n=== Period: ${period.label} (${period.start} → ${period.end}) ===`);
    const m15 = await fetchCandles('M15', period.start, period.end);
    const h1 = await fetchCandles('H1', period.start, period.end);
    const h4 = await fetchCandles('H4', period.start, period.end);
    const d1 = await fetchCandles('D1', period.start, period.end);
    console.log(`Loaded: M15=${m15.length} H1=${h1.length} H4=${h4.length} D1=${d1.length}`);

    if (m15.length < 200) {
      console.log(`Insufficient M15 candles for ${period.label}, skipping.`);
      continue;
    }

    const startMs = new Date(period.start).getTime();
    const endMs = new Date(period.end).getTime();
    const months = Math.max(1, (endMs - startMs) / (1000 * 60 * 60 * 24 * 30));

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
        const tpm = result.metrics.totalTrades / months;

        allResults.push({
          strategy: strat.name,
          account,
          period: period.label,
          trades: result.metrics.totalTrades,
          tradesPerMonth: Math.round(tpm * 10) / 10,
          winRate: result.metrics.winRate,
          profitFactor: result.metrics.profitFactor,
          returnPercent: result.metrics.returnPercent,
          maxDrawdownPercent: result.metrics.maxDrawdownPercent,
          sharpeRatio: result.metrics.sharpeRatio,
          finalBalance: result.metrics.finalBalance,
          avgRR: result.metrics.avgRR,
          passed: evaluate(result.metrics, account, months),
        });

        const m = result.metrics;
        console.log(
          `  ${strat.name.padEnd(7)} $${String(account).padStart(5)}  ` +
          `trades=${String(m.totalTrades).padStart(3)} (${tpm.toFixed(1)}/mo)  ` +
          `win=${String(m.winRate).padStart(5)}%  pnl=${(m.returnPercent>=0?'+':'')+m.returnPercent.toFixed(1)}%  ` +
          `dd=${m.maxDrawdownPercent}%  Sharpe=${m.sharpeRatio}  PF=${m.profitFactor}`,
        );
      }
    }
  }

  // Build markdown report
  let md = `# V5.5b / V6 / V6-alt Comparison Matrix — XAUUSD\n\n`;
  md += `Generated: ${new Date().toISOString()}\n\n`;
  md += `Source data: Dukascopy historical (DB-backed)\n\n`;

  md += `## Acceptance criteria per cell\n`;
  md += `- ≥ 10 trades / month\n- Profit factor ≥ 1.5\n- Sharpe ≥ 1.0\n- Max DD ≤ 20% ($100: ≤ 25%)\n- Return ≥ 0%\n\n`;

  for (const period of PERIODS) {
    md += `## ${period.label} (${period.start} → ${period.end})\n\n`;
    md += `| Strategy | Account | Trades | t/mo | Win% | Return% | Max DD% | Sharpe | PF | RR | ✅ |\n`;
    md += `|----------|---------|--------|------|------|---------|---------|--------|-----|-----|-----|\n`;
    for (const r of allResults.filter((x) => x.period === period.label)) {
      md += `| ${r.strategy} | $${r.account} | ${r.trades} | ${r.tradesPerMonth} | ${r.winRate} | ` +
            `${(r.returnPercent>=0?'+':'')}${r.returnPercent.toFixed(1)} | ${r.maxDrawdownPercent} | ` +
            `${r.sharpeRatio} | ${r.profitFactor} | ${r.avgRR} | ${r.passed ? '✅' : '❌'} |\n`;
    }
    md += `\n`;
  }

  // Aggregate winner table
  md += `## Aggregate by strategy (avg across all cells)\n\n`;
  md += `| Strategy | Avg Trades/mo | Avg Return% | Avg DD% | Avg Sharpe | Avg PF | Pass Rate |\n`;
  md += `|----------|---------------|-------------|---------|------------|--------|-----------|\n`;
  for (const strat of STRATEGIES) {
    const cells = allResults.filter((r) => r.strategy === strat.name);
    if (!cells.length) continue;
    const avg = (k: keyof CellResult) =>
      cells.reduce((s, c) => s + Number(c[k] as number), 0) / cells.length;
    const passRate = cells.filter((c) => c.passed).length / cells.length;
    md += `| ${strat.name} | ${avg('tradesPerMonth').toFixed(1)} | `+
          `${avg('returnPercent').toFixed(1)} | ${avg('maxDrawdownPercent').toFixed(1)} | `+
          `${avg('sharpeRatio').toFixed(2)} | ${avg('profitFactor').toFixed(2)} | ${(passRate*100).toFixed(0)}% |\n`;
  }

  const outDir = join(__dirname, '..', 'reports');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'v6-comparison.md');
  writeFileSync(outPath, md);
  writeFileSync(join(outDir, 'v6-comparison.json'), JSON.stringify(allResults, null, 2));
  console.log(`\nWrote ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
