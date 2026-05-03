/**
 * EURUSD V6-alt parameter sweep.
 * Mutates the registered config in-place per iteration, runs $1k backtest
 * across 2023, 2024, 2025, 2026-YTD, scores each combination, ranks them.
 */
import 'reflect-metadata';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { BacktestEngine } from '../src/backtest/engine/backtest-engine';
import { BacktestCandle, EngineConfig } from '../src/backtest/engine/types';
import { SMC_PAIR_REGISTRY } from '../src/backtest/engine/smc/pairs';

const EXEC_URL = process.env.EXECUTION_SERVICE_URL ?? 'http://localhost:8000';
const SYMBOL = 'EURUSD';

const PERIODS = [
  { label: '2023', start: '2023-01-15', end: '2023-12-31' },
  { label: '2024', start: '2024-01-01', end: '2024-12-31' },
  { label: '2025', start: '2025-01-01', end: '2025-12-31' },
  { label: '2026-YTD', start: '2026-01-01', end: '2026-04-30' },
];

async function fetchCandles(tf: string, start: string, end: string): Promise<BacktestCandle[]> {
  const url = `${EXEC_URL}/historical-candles?symbol=${SYMBOL}&timeframe=${tf}&start=${start}&end=${end}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`fetch ${tf}: ${r.status}`);
      return (await r.json()) as BacktestCandle[];
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
    }
  }
  return [];
}

interface PeriodResult {
  trades: number;
  tradesPerMonth: number;
  return: number;
  pf: number;
  sharpe: number;
  maxDD: number;
  winRate: number;
}

interface Config {
  sweepBufferAtr: number;
  trendingD1Adx: number;
  slBufferAtrM15: number;
  tp2R: number;
  d1AdxFloor: number;
  setupExpiryH1Bars: number;
  killzones: Array<[number, number]>;
}

interface Eval {
  config: Config;
  byPeriod: Record<string, PeriodResult>;
  totalReturn: number;
  avgPF: number;
  avgSharpe: number;
  totalTrades: number;
  profitableYears: number;
  score: number;
}

async function main() {
  // Pre-fetch candles once per period
  console.log(`Pre-fetching ${SYMBOL} candles for all periods...`);
  const candleData: Record<string, { m15: BacktestCandle[]; h1: BacktestCandle[]; h4: BacktestCandle[]; d1: BacktestCandle[]; months: number }> = {};
  for (const p of PERIODS) {
    const m15 = await fetchCandles('M15', p.start, p.end);
    const h1 = await fetchCandles('H1', p.start, p.end);
    const h4 = await fetchCandles('H4', p.start, p.end);
    const d1 = await fetchCandles('D1', p.start, p.end);
    const months = Math.max(1, (Date.parse(p.end) - Date.parse(p.start)) / (1000 * 60 * 60 * 24 * 30));
    candleData[p.label] = { m15, h1, h4, d1, months };
    console.log(`  ${p.label}: M15=${m15.length} H1=${h1.length}`);
  }

  // Build config combinations to try
  const sweepBuffers = [0.10, 0.15, 0.20, 0.25];
  const trendingAdx = [16, 18, 20, 22];
  const slBuffers = [0.20, 0.30];
  const tp2Rs = [2.5, 3.5];
  const d1Floors = [10, 14];
  const expiries = [8, 12];
  // Killzone variants
  const kzVariants: Array<{ tag: string; zones: Array<[number, number]> }> = [
    { tag: 'overlap-only',  zones: [[12, 16]] },
    { tag: 'london+ny',     zones: [[7, 11], [13, 17]] },
    { tag: 'wide-london+ny',zones: [[6, 12], [12, 18]] },
  ];

  const configs: Config[] = [];
  for (const sweepBufferAtr of sweepBuffers) {
    for (const trendingD1Adx of trendingAdx) {
      for (const slBufferAtrM15 of slBuffers) {
        for (const tp2R of tp2Rs) {
          for (const d1AdxFloor of d1Floors) {
            for (const setupExpiryH1Bars of expiries) {
              for (const kz of kzVariants) {
                configs.push({
                  sweepBufferAtr,
                  trendingD1Adx,
                  slBufferAtrM15,
                  tp2R,
                  d1AdxFloor,
                  setupExpiryH1Bars,
                  killzones: kz.zones,
                });
              }
            }
          }
        }
      }
    }
  }

  console.log(`\nSweeping ${configs.length} configs across ${PERIODS.length} periods...\n`);

  const baseConfig = SMC_PAIR_REGISTRY['EURUSD'];
  const evals: Eval[] = [];
  let i = 0;

  for (const cfg of configs) {
    // Mutate the registered config (smc-engine reads via getSmcPairConfig at run time)
    Object.assign(baseConfig, cfg);

    const byPeriod: Record<string, PeriodResult> = {};
    let totalReturn = 0;
    let pfSum = 0, pfCount = 0;
    let sharpeSum = 0, sharpeCount = 0;
    let totalTrades = 0;
    let profitableYears = 0;

    for (const p of PERIODS) {
      const data = candleData[p.label];
      const ec: EngineConfig = {
        symbol: SYMBOL,
        initialBalance: 1000,
        riskPercent: 1.5,
        maxDailyLossPercent: 4.0,
        maxConsecutiveLosses: 5,
        maxOpenPositions: 4,
        strategyVersion: 'V6-alt',
      };
      const engine = new BacktestEngine();
      const result = engine.run(data.m15, data.h1, ec, { h4Candles: data.h4, d1Candles: data.d1 });
      const m = result.metrics;
      const r: PeriodResult = {
        trades: m.totalTrades,
        tradesPerMonth: Math.round((m.totalTrades / data.months) * 10) / 10,
        return: m.returnPercent,
        pf: m.profitFactor,
        sharpe: m.sharpeRatio,
        maxDD: m.maxDrawdownPercent,
        winRate: m.winRate,
      };
      byPeriod[p.label] = r;
      totalReturn += r.return;
      totalTrades += r.trades;
      if (r.return > 0) profitableYears++;
      if (isFinite(r.pf) && r.pf > 0) { pfSum += r.pf; pfCount++; }
      if (isFinite(r.sharpe)) { sharpeSum += r.sharpe; sharpeCount++; }
    }

    const avgPF = pfCount > 0 ? pfSum / pfCount : 0;
    const avgSharpe = sharpeCount > 0 ? sharpeSum / sharpeCount : 0;
    const tradesPerMonthAvg = totalTrades / 39; // ~39 months total

    // Score = totalReturn * profitableYears + bonus for trade frequency hitting target
    const freqBonus = tradesPerMonthAvg >= 10 ? 20 : tradesPerMonthAvg * 2;
    const score = totalReturn * profitableYears + freqBonus + avgPF * 5;

    evals.push({ config: cfg, byPeriod, totalReturn, avgPF, avgSharpe, totalTrades, profitableYears, score });

    if (++i % 50 === 0) console.log(`  progress: ${i}/${configs.length}`);
  }

  // Rank by score
  evals.sort((a, b) => b.score - a.score);

  console.log(`\n=== Top 10 EURUSD configs ===\n`);
  for (let k = 0; k < Math.min(10, evals.length); k++) {
    const e = evals[k];
    console.log(`Rank ${k + 1}: score=${e.score.toFixed(1)} totalRet=+${e.totalReturn.toFixed(1)}% profitYrs=${e.profitableYears}/4 trades=${e.totalTrades} avgPF=${e.avgPF.toFixed(2)} avgSharpe=${e.avgSharpe.toFixed(2)}`);
    console.log(`  cfg: sweepBuf=${e.config.sweepBufferAtr} trendAdx=${e.config.trendingD1Adx} slBuf=${e.config.slBufferAtrM15} tp2=${e.config.tp2R} adxFloor=${e.config.d1AdxFloor} expiry=${e.config.setupExpiryH1Bars} kz=${JSON.stringify(e.config.killzones)}`);
    for (const p of PERIODS) {
      const r = e.byPeriod[p.label];
      console.log(`    ${p.label}: ${String(r.trades).padStart(3)} trades (${r.tradesPerMonth}/mo) ${(r.return>=0?'+':'')+r.return.toFixed(1)}% PF=${r.pf} win=${r.winRate}%`);
    }
  }

  const outDir = join(__dirname, '..', 'reports');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'eurusd-sweep.json'), JSON.stringify(evals.slice(0, 30), null, 2));
  console.log(`\nWrote reports/eurusd-sweep.json (top 30 of ${evals.length})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
