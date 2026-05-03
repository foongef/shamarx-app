/**
 * Standalone backtest runner — invokes BacktestEngine directly without going
 * through the NestJS HTTP layer. Pulls candles from the execution-service.
 *
 * Usage:
 *   pnpm exec ts-node -P tsconfig.build.json scripts/run-backtest.ts \
 *     --symbol XAUUSD --start 2024-01-01 --end 2024-12-31 \
 *     --balance 1000 --risk 1.0 --strategy V6
 */
import 'reflect-metadata';
import { BacktestEngine } from '../src/backtest/engine/backtest-engine';
import { BacktestCandle, EngineConfig, StrategyVersion } from '../src/backtest/engine/types';

const EXEC_URL = process.env.EXECUTION_SERVICE_URL ?? 'http://localhost:8000';

async function fetchCandles(symbol: string, tf: string, start: string, end: string): Promise<BacktestCandle[]> {
  const url = `${EXEC_URL}/historical-candles?symbol=${symbol}&timeframe=${tf}&start=${start}&end=${end}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetchCandles ${tf} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as BacktestCandle[];
}

interface CliArgs {
  symbol: string;
  start: string;
  end: string;
  balance: number;
  risk: number;
  strategy: StrategyVersion;
  output?: string;
}

function parseArgs(): CliArgs {
  const args: Record<string, string> = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const k = process.argv[i].replace(/^--/, '');
    args[k] = process.argv[i + 1];
  }
  return {
    symbol: args.symbol ?? 'XAUUSD',
    start: args.start,
    end: args.end,
    balance: Number(args.balance ?? '1000'),
    risk: Number(args.risk ?? '1.0'),
    strategy: (args.strategy as StrategyVersion) ?? 'V6',
    output: args.output,
  };
}

async function main() {
  const a = parseArgs();
  if (!a.start || !a.end) {
    console.error('Usage: --symbol XAUUSD --start YYYY-MM-DD --end YYYY-MM-DD --balance 1000 --risk 1.0 --strategy V6');
    process.exit(1);
  }

  console.log(`Fetching candles for ${a.symbol} ${a.start} → ${a.end} ...`);
  const m15 = await fetchCandles(a.symbol, 'M15', a.start, a.end);
  const h1 = await fetchCandles(a.symbol, 'H1', a.start, a.end);
  const h4 = a.strategy !== 'V5.5b' ? await fetchCandles(a.symbol, 'H4', a.start, a.end) : [];
  const d1 = a.strategy !== 'V5.5b' ? await fetchCandles(a.symbol, 'D1', a.start, a.end) : [];
  console.log(`Candles: M15=${m15.length} H1=${h1.length} H4=${h4.length} D1=${d1.length}`);

  if (m15.length < 200) {
    console.error(`Not enough M15 candles (${m15.length}). Need ≥ 200.`);
    process.exit(2);
  }

  const config: EngineConfig = {
    symbol: a.symbol,
    initialBalance: a.balance,
    riskPercent: a.risk,
    maxDailyLossPercent: 4.0,
    maxConsecutiveLosses: 5,
    maxOpenPositions: 4,
    strategyVersion: a.strategy,
  };

  const engine = new BacktestEngine();
  const t0 = Date.now();
  const result = engine.run(m15, h1, config, { h4Candles: h4, d1Candles: d1 });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  const m = result.metrics;
  const startD = new Date(a.start);
  const endD = new Date(a.end);
  const months = Math.max(1, (endD.getTime() - startD.getTime()) / (1000 * 60 * 60 * 24 * 30));
  const tradesPerMonth = (m.totalTrades / months).toFixed(1);

  const summary = {
    strategy: a.strategy,
    symbol: a.symbol,
    range: `${a.start} → ${a.end}`,
    balance: a.balance,
    risk: a.risk,
    runtimeSec: dt,
    metrics: {
      totalTrades: m.totalTrades,
      tradesPerMonth,
      winRate: m.winRate,
      profitFactor: m.profitFactor,
      totalPnl: m.totalPnl,
      returnPercent: m.returnPercent,
      maxDrawdownPercent: m.maxDrawdownPercent,
      sharpeRatio: m.sharpeRatio,
      finalBalance: m.finalBalance,
      avgRR: m.avgRR,
      maxConsecutiveLosses: m.maxConsecutiveLosses,
    },
  };

  console.log('\n=== Result ===');
  console.log(JSON.stringify(summary, null, 2));

  if (a.output) {
    const fs = await import('fs');
    fs.writeFileSync(a.output, JSON.stringify(summary, null, 2));
    console.log(`Wrote ${a.output}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
