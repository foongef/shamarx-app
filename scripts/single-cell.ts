import 'reflect-metadata';
import { BacktestEngine } from '../src/backtest/engine/backtest-engine';
import { BacktestCandle, EngineConfig } from '../src/backtest/engine/types';

const EXEC_URL = 'http://localhost:8000';
async function fetch1(symbol: string, tf: string, start: string, end: string) {
  const r = await fetch(`${EXEC_URL}/historical-candles?symbol=${symbol}&timeframe=${tf}&start=${start}&end=${end}`);
  return (await r.json()) as BacktestCandle[];
}

(async () => {
  // Mimic the NestJS service exactly: 90-day HTF warmup
  const start = '2025-01-01';
  const end = '2025-12-31';
  const htfStart = new Date(start);
  htfStart.setUTCDate(htfStart.getUTCDate() - 90);
  const htfStartStr = htfStart.toISOString().slice(0, 10);

  const m15 = await fetch1('XAUUSD', 'M15', start, end);
  const h1 = await fetch1('XAUUSD', 'H1', htfStartStr, end);
  const h4 = await fetch1('XAUUSD', 'H4', htfStartStr, end);
  const d1 = await fetch1('XAUUSD', 'D1', htfStartStr, end);
  console.log(`M15=${m15.length} H1=${h1.length} H4=${h4.length} D1=${d1.length}`);

  const cfg: EngineConfig = {
    symbol: 'XAUUSD', initialBalance: 1000, riskPercent: 1.5,
    maxDailyLossPercent: 4.0, maxConsecutiveLosses: 5, maxOpenPositions: 4,
    strategyVersion: 'V6-alt',
  };
  const r = new BacktestEngine().run(m15, h1, cfg, { h4Candles: h4, d1Candles: d1 });
  const m = r.metrics;
  console.log(`trades=${m.totalTrades}  win=${m.winRate}%  ret=${m.returnPercent}%  PF=${m.profitFactor}`);
})();
