'use client';

import Link from 'next/link';
import { ArrowUpRight, Plus } from 'lucide-react';
import { useBacktests } from '@/hooks/use-backtests';
import {
  buildStrategyAggregates,
  STRATEGY_META,
  strategyOf,
  syntheticEquityCurve,
} from '@/lib/aggregate';
import { Panel } from '@/components/backtest/panel';
import { MetricChip } from '@/components/backtest/metric-chip';
import { StrategyBadge } from '@/components/backtest/strategy-badge';
import { Sparkline } from '@/components/backtest/sparkline';
import { StatusDot } from '@/components/backtest/status-dot';
import {
  formatNum,
  formatPct,
  formatRatio,
  formatSignedMoney,
} from '@/components/backtest/value';
import { cn } from '@/lib/utils';

export default function HomePage() {
  const { data: runs = [], isLoading } = useBacktests();
  const aggregates = buildStrategyAggregates(runs);
  const completed = runs.filter((r) => r.status === 'COMPLETED' && r.metrics);
  const totalRuns = runs.length;
  const totalTrades = completed.reduce(
    (s, r) => s + (r.metrics?.totalTrades ?? 0),
    0,
  );
  const totalPnL = completed.reduce(
    (s, r) => s + (r.metrics?.totalPnl ?? 0),
    0,
  );
  const avgWinRate = completed.length
    ? completed.reduce((s, r) => s + (r.metrics?.winRate ?? 0), 0) /
      completed.length
    : 0;
  const bestRun = completed.reduce<typeof completed[number] | null>(
    (best, r) =>
      !best || (r.metrics?.returnPercent ?? -Infinity) >
        (best.metrics?.returnPercent ?? -Infinity)
        ? r
        : best,
    null,
  );

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-8 pb-12">
      {/* ─── Hero / aggregate stats ───────────────────────────────────── */}
      <section className="reveal-up grid grid-cols-12 gap-x-6 gap-y-4 border-b border-border pb-10 pt-2">
        <div className="col-span-12 lg:col-span-7">
          <div className="label-eyebrow mb-3">
            <span className="text-signal">●</span> &nbsp;Backtest Terminal · 2026
          </div>
          <h1 className="display-serif text-[clamp(36px,5.5vw,72px)] font-medium leading-[0.95] tracking-tight">
            Where strategy
            <br />
            meets the
            <span className="italic"> tape</span>.
          </h1>
          <p className="mt-5 max-w-xl text-[14px] leading-relaxed text-muted-foreground">
            A quantitative backtest workspace for XAUUSD intraday and SMC
            strategies. Compare V5.5b, V6 and V6-alt across years, accounts and
            market regimes — see every trade marked on the tape, every metric
            in mono-numeric clarity.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <Link
              href="/backtest/new"
              className="group inline-flex items-center gap-2 border border-foreground bg-foreground px-4 py-2 text-[12.5px] font-medium uppercase tracking-widest text-background transition-colors hover:bg-signal hover:border-signal hover:text-signal-foreground"
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
              New Backtest
            </Link>
            <Link
              href="/backtest"
              className="inline-flex items-center gap-2 px-4 py-2 text-[12.5px] uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground"
            >
              All runs
              <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.75} />
            </Link>
          </div>
        </div>

        <div className="col-span-12 lg:col-span-5">
          <div className="relative h-full border border-border bg-card p-6 frame-brackets">
            <div className="grid-pattern absolute inset-0 opacity-[0.06]" />
            <div className="relative grid grid-cols-2 gap-x-6 gap-y-6">
              <MetricChip
                label="Total Runs"
                value={formatNum(totalRuns, 0)}
                size="lg"
              />
              <MetricChip
                label="Total Trades"
                value={formatNum(totalTrades, 0)}
                size="lg"
              />
              <MetricChip
                label="Aggregate PnL"
                value={formatSignedMoney(totalPnL, 0)}
                tone={totalPnL >= 0 ? 'profit' : 'loss'}
                size="lg"
              />
              <MetricChip
                label="Avg Win Rate"
                value={
                  completed.length === 0 ? '—' : `${avgWinRate.toFixed(1)}%`
                }
                size="lg"
                tone="signal"
              />
            </div>
            {bestRun && (
              <div className="relative mt-6 flex items-center justify-between border-t border-border pt-4">
                <div className="flex items-center gap-2">
                  <span className="label-eyebrow">Top Run</span>
                  <StrategyBadge version={strategyOf(bestRun)} />
                </div>
                <Link
                  href={`/backtest/${bestRun.id}`}
                  className="flex items-center gap-2 font-mono text-[12px] tnum text-profit hover:text-foreground"
                >
                  {formatPct(bestRun.metrics?.returnPercent)}
                  <ArrowUpRight className="h-3 w-3" />
                </Link>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ─── Strategy comparison cards ─────────────────────────────────── */}
      <section className="flex flex-col gap-4">
        <div className="flex items-end justify-between">
          <div className="flex flex-col gap-1">
            <span className="label-eyebrow">
              <span className="text-signal">◆</span>&nbsp;Strategies in rotation
            </span>
            <h2 className="display-serif text-[28px] leading-tight tracking-tight">
              Three challengers,
              <span className="italic"> one tape</span>.
            </h2>
          </div>
          <Link
            href="/backtest/new"
            className="hidden text-[12px] uppercase tracking-widest text-muted-foreground hover:text-foreground sm:inline-flex"
          >
            Run comparison →
          </Link>
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {aggregates.map((a, i) => {
            const meta = STRATEGY_META[a.strategy];
            return (
              <div
                key={a.strategy}
                className={cn(
                  'reveal-up group relative flex flex-col gap-4 border border-border bg-card p-5 transition-colors hover:border-border-strong',
                  `reveal-delay-${(i + 1) as 1 | 2 | 3}`,
                )}
              >
                <div className="flex items-start justify-between">
                  <StrategyBadge version={a.strategy} size="md" />
                  <span className="font-mono text-[10px] tabular-nums text-subtle">
                    {String(a.runs).padStart(2, '0')} run{a.runs === 1 ? '' : 's'}
                  </span>
                </div>
                <h3
                  className={cn(
                    'display-serif text-[22px] leading-tight tracking-tight',
                    meta.hue,
                  )}
                >
                  {meta.blurb}
                </h3>
                <p className="text-[12.5px] leading-relaxed text-muted-foreground">
                  {meta.description}
                </p>
                <div className="mt-auto grid grid-cols-3 gap-3 border-t border-border pt-4">
                  <MetricChip
                    label="Avg Ret"
                    value={
                      a.runs ? formatPct(a.avgReturn, 1) : '—'
                    }
                    tone={a.avgReturn >= 0 ? 'profit' : 'loss'}
                    size="sm"
                  />
                  <MetricChip
                    label="Avg PF"
                    value={a.runs ? formatRatio(a.avgPF) : '—'}
                    tone={a.avgPF >= 1.5 ? 'signal' : 'default'}
                    size="sm"
                  />
                  <MetricChip
                    label="Avg DD"
                    value={a.runs ? `${a.avgDD.toFixed(1)}%` : '—'}
                    size="sm"
                  />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ─── Recent runs ─────────────────────────────────────────────── */}
      <section className="flex flex-col gap-4">
        <div className="flex items-end justify-between">
          <div className="flex flex-col gap-1">
            <span className="label-eyebrow">
              <span className="text-signal">◆</span>&nbsp;The Tape
            </span>
            <h2 className="display-serif text-[28px] leading-tight tracking-tight">
              Recent runs.
            </h2>
          </div>
          <Link
            href="/backtest"
            className="text-[12px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
          >
            View all →
          </Link>
        </div>

        <Panel bodyClassName="p-0" brackets>
          {isLoading && (
            <div className="px-4 py-8 text-center text-[12px] text-muted-foreground">
              Loading the tape…
            </div>
          )}
          {!isLoading && runs.length === 0 && (
            <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
              <span className="font-mono text-[10px] uppercase tracking-widest text-subtle">
                ─── No runs yet ───
              </span>
              <p className="max-w-md text-[13px] text-muted-foreground">
                Spin up a backtest to see strategies marked against the tape,
                trade-by-trade.
              </p>
              <Link
                href="/backtest/new"
                className="mt-2 inline-flex items-center gap-2 border border-signal/40 bg-signal/5 px-4 py-1.5 text-[11.5px] uppercase tracking-widest text-signal transition-colors hover:bg-signal hover:text-signal-foreground"
              >
                Create first run
              </Link>
            </div>
          )}
          {runs.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="border-b border-border bg-surface">
                    <Th>Run</Th>
                    <Th>Strategy</Th>
                    <Th>Symbol</Th>
                    <Th align="right">Period</Th>
                    <Th align="right">Bal</Th>
                    <Th align="right">Equity</Th>
                    <Th align="right">PnL</Th>
                    <Th align="right">Win%</Th>
                    <Th align="right">PF</Th>
                    <Th align="right">DD</Th>
                    <Th align="right">Trades</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {runs.slice(0, 8).map((run) => {
                    const m = run.metrics;
                    const ret = m?.returnPercent ?? 0;
                    const isProfit = ret >= 0;
                    return (
                      <tr key={run.id} className="row-hover transition-colors">
                        <Td>
                          <Link
                            href={`/backtest/${run.id}`}
                            className="flex items-center gap-2"
                          >
                            <StatusDot status={run.status} />
                            <span className="font-mono text-[11px] text-muted-foreground">
                              {run.id.slice(0, 8)}
                            </span>
                          </Link>
                        </Td>
                        <Td>
                          <StrategyBadge version={strategyOf(run)} />
                        </Td>
                        <Td>
                          <span className="font-mono text-[11.5px] uppercase tracking-wide">
                            {run.symbol}
                          </span>
                        </Td>
                        <Td align="right">
                          <span className="font-mono text-[11px] tnum text-muted-foreground">
                            {run.startDate.slice(0, 7)} → {run.endDate.slice(0, 7)}
                          </span>
                        </Td>
                        <Td align="right">
                          <span className="font-mono tnum text-muted-foreground">
                            ${formatNum(run.initialBalance, 0)}
                          </span>
                        </Td>
                        <Td align="right">
                          <Sparkline
                            data={syntheticEquityCurve(run)}
                            positive={isProfit}
                            width={84}
                            height={20}
                            showLast
                            className="ml-auto"
                          />
                        </Td>
                        <Td
                          align="right"
                          className={cn(
                            'font-mono tnum',
                            isProfit ? 'text-profit' : 'text-loss',
                          )}
                        >
                          {m ? formatPct(ret) : '—'}
                        </Td>
                        <Td align="right">
                          {m ? `${m.winRate.toFixed(1)}%` : '—'}
                        </Td>
                        <Td align="right">
                          {m ? formatRatio(m.profitFactor) : '—'}
                        </Td>
                        <Td align="right">
                          {m ? `${m.maxDrawdownPercent.toFixed(1)}%` : '—'}
                        </Td>
                        <Td align="right">
                          {m ? formatNum(m.totalTrades, 0) : '—'}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </section>
    </div>
  );
}

function Th({
  children,
  align = 'left',
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
}) {
  return (
    <th
      className={cn(
        'label-eyebrow whitespace-nowrap px-3 py-2.5',
        align === 'right' ? 'text-right' : 'text-left',
      )}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align = 'left',
  className,
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
  className?: string;
}) {
  return (
    <td
      className={cn(
        'whitespace-nowrap px-3 py-2.5 font-mono tabular-nums',
        align === 'right' ? 'text-right' : 'text-left',
        className,
      )}
    >
      {children}
    </td>
  );
}
