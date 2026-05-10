/**
 * Comparison runner — replays the SAME window with different SMC gate
 * combinations to validate whether new structure gates (FVG / OB / BOS)
 * preserve or improve baseline profitability.
 *
 * Usage:
 *   pnpm exec ts-node -P tsconfig.build.json scripts/compare-smc-gates.ts \
 *     --start 2024-05-07 --end 2026-05-07 --balance 10000 --risk 1.5
 *
 * Optional: --pairs XAUUSD,EURUSD     (default: all 4)
 *           --scenarios baseline,fvg  (default: baseline,fvg,ob,bos,fvg+ob,all)
 *
 * Outputs a side-by-side table of trade count / win rate / realised PnL /
 * max DD / "rank vs baseline". Non-mutating — prints results, doesn't
 * write to the DB.
 */
import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { LiveSmcOrchestrator } from '../src/strategy/live/live-smc-orchestrator';
import { LiveRangeOrchestrator } from '../src/strategy/live/live-range-orchestrator';
import { ReplayEngine, CandleBundle } from '../src/backtest/live-replay/replay-engine';
import { BacktestCandle } from '../src/backtest/engine/types';
import { REPLAY_DEFAULT_PAIRS } from '../src/backtest/live-replay/dto/start-replay.dto';
import {
  setSmcPairConfigOverride,
  clearSmcPairConfigOverrides,
} from '../src/backtest/engine/smc/pairs';
import {
  setRangePairConfigOverride,
  clearRangePairConfigOverrides,
} from '../src/backtest/engine/range/pairs';

const HTF_WARMUP_DAYS = 90;

interface CliArgs {
  start: string;
  end: string;
  balance: number;
  risk: number;
  pairs: string[];
  scenarios: string[];
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
    pairs: raw.pairs
      ? raw.pairs.split(',').map((s) => s.trim().toUpperCase())
      : REPLAY_DEFAULT_PAIRS,
    scenarios: raw.scenarios
      ? raw.scenarios.split(',').map((s) => s.trim().toLowerCase())
      : [
          'baseline',
          // Strategy #2 — range reversion in low-ADX regimes
          'combined',
        ],
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

const SCENARIO_GATES: Record<
  string,
  Partial<{
    // Old (failed) post-entry gates — kept for regression visibility,
    // not in the default scenario list since the 2026-05-09 validation
    // showed they all hurt the strategy.
    useFvgGate: boolean;
    useObGate: boolean;
    useBosGate: boolean;
    // Path-3 pre-sweep validity gates — what we're actually validating
    useObOriginGate: boolean;
    useImpulseFvgGate: boolean;
    useBosOriginGate: boolean;
  }>
> = {
  baseline: {},
  // Old (failed) gates — opt-in via --scenarios for regression check
  fvg: { useFvgGate: true },
  ob: { useObGate: true },
  bos: { useBosGate: true },
  'fvg+ob': { useFvgGate: true, useObGate: true },
  all: { useFvgGate: true, useObGate: true, useBosGate: true },
  // Path-3 new gates — these are what we're validating now
  'p3-ob': { useObOriginGate: true },
  'p3-fvg': { useImpulseFvgGate: true },
  'p3-bos': { useBosOriginGate: true },
  'p3-ob+fvg': { useObOriginGate: true, useImpulseFvgGate: true },
  'p3-ob+bos': { useObOriginGate: true, useBosOriginGate: true },
  'p3-fvg+bos': { useImpulseFvgGate: true, useBosOriginGate: true },
  'p3-all': {
    useObOriginGate: true,
    useImpulseFvgGate: true,
    useBosOriginGate: true,
  },
};

interface ScenarioResult {
  scenario: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  realizedPnl: number;
  netReturnPct: number;
  maxConcurrent: number;
  runtimeSec: number;
}

async function runScenario(
  scenario: string,
  pairs: string[],
  bundle: CandleBundle,
  args: CliArgs,
): Promise<ScenarioResult> {
  // Reset overrides before applying scenario-specific config so prior
  // scenario state doesn't leak.
  clearSmcPairConfigOverrides();
  clearRangePairConfigOverrides();

  let enableRange = false;

  if (scenario === 'combined' || scenario === 'range-only') {
    enableRange = true;
    for (const p of pairs) {
      setRangePairConfigOverride(p, { enabled: true });
    }
  } else if (scenario === 'combined-loose') {
    // Loosened gates — first comparison fired only ONE range trade in 28
    // months, indicating the conservative defaults are too strict to
    // ever co-trigger. Loosen each gate by ~1 stddev and re-run to see
    // whether range can actually contribute alpha.
    enableRange = true;
    for (const p of pairs) {
      const xau = p === 'XAUUSD';
      setRangePairConfigOverride(p, {
        enabled: true,
        rsiOversold: xau ? 25 : 30, // 25 → 30 (XAU stays slightly tighter)
        rsiOverbought: xau ? 75 : 70, // 75 → 70
        d1AdxMaxForRange: xau ? 27 : 25, // 22 → 25 (24 → 27 for XAU)
        atrSpikeRatio: xau ? 3.0 : 3.0, // 2.0 → 3.0
        minMeanDistanceAtr: xau ? 0.8 : 0.5, // 1.0 → 0.5 (1.2 → 0.8 for XAU)
      });
    }
  } else if (scenario === 'combined-very-loose') {
    // Belt-and-braces — go even further to detect whether the issue is
    // gates vs detector logic. If THIS doesn't fire many trades, the
    // detector itself has a bug.
    enableRange = true;
    for (const p of pairs) {
      setRangePairConfigOverride(p, {
        enabled: true,
        rsiOversold: 35,
        rsiOverbought: 65,
        d1AdxMaxForRange: 28,
        atrSpikeRatio: 4.0,
        minMeanDistanceAtr: 0.3,
      });
    }
  } else {
    const gates = SCENARIO_GATES[scenario];
    if (!gates) throw new Error(`Unknown scenario: ${scenario}`);
    for (const p of pairs) {
      setSmcPairConfigOverride(p, gates);
    }
  }

  const orchestrator = new LiveSmcOrchestrator();
  const rangeOrchestrator = enableRange ? new LiveRangeOrchestrator() : null;
  const engine = new ReplayEngine(orchestrator, rangeOrchestrator);
  const t0 = Date.now();
  const result = await engine.run(
    {
      startDate: args.start,
      endDate: args.end,
      initialBalance: args.balance,
      riskPercent: args.risk,
      pairs,
    },
    bundle,
  );
  const runtimeSec = (Date.now() - t0) / 1000;

  return {
    scenario,
    trades: result.metrics.tradesCount,
    wins: result.metrics.winsCount,
    losses: result.metrics.lossesCount,
    winRate: result.metrics.tradesCount > 0
      ? (result.metrics.winsCount / result.metrics.tradesCount) * 100
      : 0,
    realizedPnl: result.metrics.realizedPnl,
    netReturnPct: result.metrics.netReturnPct,
    maxConcurrent: result.maxConcurrent,
    runtimeSec,
  };
}

function printTable(results: ScenarioResult[], baseline: ScenarioResult): void {
  const lines: string[] = [];
  const pad = (s: string, n: number) => s.padEnd(n);
  const padR = (s: string, n: number) => s.padStart(n);

  lines.push('');
  lines.push(
    pad('Scenario', 12) +
      padR('Trades', 8) +
      padR('Wins', 7) +
      padR('Losses', 8) +
      padR('WR%', 7) +
      padR('PnL$', 12) +
      padR('Return%', 10) +
      padR('vs base', 10) +
      padR('Runtime', 10),
  );
  lines.push('─'.repeat(84));

  for (const r of results) {
    const dPnl = r.realizedPnl - baseline.realizedPnl;
    const dRet = r.netReturnPct - baseline.netReturnPct;
    const cmp = r.scenario === 'baseline' ? '—' : `${dRet >= 0 ? '+' : ''}${dRet.toFixed(2)}%`;
    void dPnl;
    lines.push(
      pad(r.scenario, 12) +
        padR(String(r.trades), 8) +
        padR(String(r.wins), 7) +
        padR(String(r.losses), 8) +
        padR(r.winRate.toFixed(1), 7) +
        padR(`$${r.realizedPnl.toFixed(2)}`, 12) +
        padR(`${r.netReturnPct.toFixed(2)}`, 10) +
        padR(cmp, 10) +
        padR(`${r.runtimeSec.toFixed(0)}s`, 10),
    );
  }

  lines.push('');
  lines.push('Pass criteria for any scenario to ship to live:');
  lines.push('  • Win rate ≥ baseline within 1 standard error');
  lines.push('  • Realised PnL ≥ baseline');
  lines.push('  • Trade count ≥ 60% of baseline (less = filtering too hard)');
  lines.push('');

  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));
}

async function main() {
  const a = parseArgs();
  if (!a.start || !a.end) {
    console.error(
      'Usage: --start YYYY-MM-DD --end YYYY-MM-DD --balance 10000 --risk 1.5 [--pairs ...] [--scenarios baseline,fvg,...]',
    );
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const start = new Date(a.start);
    const end = new Date(a.end);
    end.setUTCHours(23, 59, 59, 999);
    const htfStart = new Date(start);
    htfStart.setUTCDate(htfStart.getUTCDate() - HTF_WARMUP_DAYS);

    console.log(`Loading candles ${a.start} → ${a.end} for ${a.pairs.join(', ')} ...`);
    const bundle: CandleBundle = {};
    for (const symbol of a.pairs) {
      const [m15, h1, d1] = await Promise.all([
        fetchTimeframe(prisma, symbol, 'M15', start, end),
        fetchTimeframe(prisma, symbol, 'H1', htfStart, end),
        fetchTimeframe(prisma, symbol, 'D1', htfStart, end),
      ]);
      bundle[symbol] = { m15, h1, d1 };
      console.log(`  [${symbol}] M15=${m15.length} H1=${h1.length} D1=${d1.length}`);
    }

    console.log('');
    console.log(`Running ${a.scenarios.length} scenarios sequentially...`);

    const results: ScenarioResult[] = [];
    for (const scenario of a.scenarios) {
      console.log(`\n  ▸ ${scenario}`);
      const r = await runScenario(scenario, a.pairs, bundle, a);
      console.log(
        `    ${r.trades} trades · ${r.winRate.toFixed(1)}% WR · $${r.realizedPnl.toFixed(2)} · ${r.netReturnPct.toFixed(2)}% return`,
      );
      results.push(r);
    }

    const baseline = results.find((r) => r.scenario === 'baseline');
    if (!baseline) {
      console.error('Could not find baseline result; printing without comparison.');
      printTable(results, results[0]);
    } else {
      printTable(results, baseline);
    }
  } finally {
    clearSmcPairConfigOverrides();
    clearRangePairConfigOverrides();
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
