/**
 * Standalone live-replay runner — drives SmcLiveEvaluator across all 4 pairs
 * on one shared simulated account, reading candles from the Candle table.
 *
 * Usage:
 *   pnpm exec ts-node -P tsconfig.build.json scripts/run-live-replay.ts \
 *     --start 2026-04-01 --end 2026-05-01 --balance 10000 --risk 1.5
 *
 * Optional: --pairs XAUUSD,EURUSD  (default: XAUUSD,EURUSD,GBPUSD,USDJPY)
 *           --output <path.json>
 */
import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { SmcLiveEvaluator } from '../src/strategy/live/smc-live-evaluator';
import { ReplayEngine, CandleBundle } from '../src/backtest/live-replay/replay-engine';
import { BacktestCandle } from '../src/backtest/engine/types';
import { REPLAY_DEFAULT_PAIRS } from '../src/backtest/live-replay/dto/start-replay.dto';

const HTF_WARMUP_DAYS = 90;

interface CliArgs {
  start: string;
  end: string;
  balance: number;
  risk: number;
  pairs: string[];
  output?: string;
}

function parseArgs(): CliArgs {
  const raw: Record<string, string> = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const k = process.argv[i].replace(/^--/, '');
    raw[k] = process.argv[i + 1];
  }
  return {
    start: raw.start,
    end: raw.end,
    balance: Number(raw.balance ?? '10000'),
    risk: Number(raw.risk ?? '1.5'),
    pairs: raw.pairs ? raw.pairs.split(',').map((s) => s.trim().toUpperCase()) : REPLAY_DEFAULT_PAIRS,
    output: raw.output,
  };
}

async function fetchTimeframe(
  prisma: PrismaClient,
  symbol: string,
  timeframe: string,
  start: Date,
  end: Date,
): Promise<BacktestCandle[]> {
  const rows = await prisma.candle.findMany({
    where: { symbol, timeframe, openTime: { gte: start, lte: end } },
    orderBy: { openTime: 'asc' },
  });
  return rows.map((r) => ({
    symbol: r.symbol,
    timeframe: r.timeframe,
    openTime: r.openTime.toISOString(),
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
  }));
}

async function main() {
  const a = parseArgs();
  if (!a.start || !a.end) {
    console.error('Usage: --start YYYY-MM-DD --end YYYY-MM-DD --balance 10000 --risk 1.5 [--pairs XAUUSD,EURUSD] [--output file.json]');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const start = new Date(a.start);
    const end = new Date(a.end);
    end.setUTCHours(23, 59, 59, 999);
    const htfStart = new Date(start);
    htfStart.setUTCDate(htfStart.getUTCDate() - HTF_WARMUP_DAYS);

    console.log(`Loading candles for ${a.pairs.join(', ')} ${a.start} → ${a.end} ...`);
    const bundle: CandleBundle = {};
    for (const symbol of a.pairs) {
      const [m15, h1, d1] = await Promise.all([
        fetchTimeframe(prisma, symbol, 'M15', start, end),
        fetchTimeframe(prisma, symbol, 'H1', htfStart, end),
        fetchTimeframe(prisma, symbol, 'D1', htfStart, end),
      ]);
      bundle[symbol] = { m15, h1, d1 };
      console.log(`  [${symbol}] M15=${m15.length} H1=${h1.length} D1=${d1.length}`);
      if (m15.length < 200) {
        console.warn(`  ⚠ ${symbol} has only ${m15.length} M15 candles — may miss trades. Run \`pnpm data:import ${symbol.toLowerCase()}\` to backfill.`);
      }
    }

    const evaluator = new SmcLiveEvaluator();
    const engine = new ReplayEngine(evaluator);
    const t0 = Date.now();
    const result = engine.run(
      {
        startDate: a.start,
        endDate: a.end,
        initialBalance: a.balance,
        riskPercent: a.risk,
        pairs: a.pairs,
      },
      bundle,
    );
    const dt = ((Date.now() - t0) / 1000).toFixed(1);

    const summary = {
      pairs: a.pairs,
      range: `${a.start} → ${a.end}`,
      balance: a.balance,
      risk: a.risk,
      runtimeSec: dt,
      metrics: result.metrics,
      maxConcurrent: result.maxConcurrent,
      finalBalance: result.finalBalance,
    };

    console.log('\n=== Result ===');
    console.log(JSON.stringify(summary, null, 2));

    if (a.output) {
      const fs = await import('fs');
      fs.writeFileSync(a.output, JSON.stringify({ ...summary, trades: result.closed }, null, 2));
      console.log(`Wrote ${a.output} (${result.closed.length} trades)`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
