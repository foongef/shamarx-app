'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowUpRight, Plus, Radio, Activity, Zap } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { useBacktests } from '@/hooks/use-backtests';
import { api } from '@/lib/api-client';
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
import { EquityCurve } from '@/components/live/equity-curve';
import { Reveal, StaggerGroup, StaggerItem } from '@/components/motion/reveal';
import { CountUp } from '@/components/motion/count-up';
import {
  formatNum,
  formatPct,
  formatRatio,
} from '@/components/backtest/value';
import { cn } from '@/lib/utils';

export default function HomePage() {
  const { data: runs = [], isLoading } = useBacktests();

  const liveStatus = useQuery({
    queryKey: ['live-status'],
    queryFn: () => api.liveStatus(),
    refetchInterval: 5000,
    refetchIntervalInBackground: true,
  });

  const sessions = useQuery({
    queryKey: ['live-sessions'],
    queryFn: () => api.liveSessions(20),
    refetchInterval: 15_000,
    refetchIntervalInBackground: true,
  });

  const equity = useQuery({
    queryKey: ['live-equity-aggregate'],
    queryFn: () => api.liveEquityHistory(168),
    refetchInterval: 60_000,
    refetchIntervalInBackground: true,
  });

  const recentTrades = useQuery({
    queryKey: ['live-recent-trades-home'],
    queryFn: () => api.liveRecentTrades(5),
    refetchInterval: 15_000,
    refetchIntervalInBackground: true,
  });

  // ─── Aggregates ──────────────────────────────────────
  const aggregates = buildStrategyAggregates(runs);
  const completed = runs.filter((r) => r.status === 'COMPLETED' && r.metrics);

  const allSessions = sessions.data?.sessions ?? [];
  const closedSessions = allSessions.filter((s) => s.status !== 'RUNNING');
  const activeSession = allSessions.find((s) => s.status === 'RUNNING');
  const totalRealized = closedSessions.reduce((s, x) => s + (x.realizedPnl ?? 0), 0);
  const totalLiveTrades = closedSessions.reduce((s, x) => s + (x.tradesCount ?? 0), 0);
  const totalWins = closedSessions.reduce((s, x) => s + (x.winsCount ?? 0), 0);
  const totalLosses = closedSessions.reduce((s, x) => s + (x.lossesCount ?? 0), 0);
  const liveWinRate = totalWins + totalLosses > 0 ? (totalWins / (totalWins + totalLosses)) * 100 : 0;
  const equityValue = liveStatus.data?.account?.equity ?? null;

  // 7d P&L from equity snapshots (first vs latest)
  const equityPoints = equity.data?.points ?? [];
  const sevenDayPnl =
    equityPoints.length >= 2
      ? equityPoints[equityPoints.length - 1].equity - equityPoints[0].equity
      : 0;

  // Last 24h trades from sessions started in the last day
  const dayMs = 24 * 60 * 60 * 1000;
  const recentSessions = closedSessions.filter(
    (s) => Date.now() - new Date(s.startedAt).getTime() < dayMs,
  );
  const last24Trades = recentSessions.reduce((s, x) => s + (x.tradesCount ?? 0), 0);
  const last24Pnl = recentSessions.reduce((s, x) => s + (x.realizedPnl ?? 0), 0);

  const isRunning = liveStatus.data?.running === true;

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-10 pb-12 lg:gap-14">
      {/* ─── Hero ───────────────────────────────────────────────────────── */}
      <Reveal as="section" className="pt-2">
        <div className="grid grid-cols-12 gap-x-6 gap-y-6">
          {/* Headline */}
          <div className="col-span-12 lg:col-span-7">
            <div className="flex items-center gap-2">
              <span className="label-eyebrow flex items-center gap-1.5">
                <span className="text-signal">●</span>
                Tape · Quantitative Workspace · 2026
              </span>
            </div>
            <h1 className="mt-3 display-serif text-[clamp(38px,6vw,80px)] font-medium leading-[0.92] tracking-tight">
              Where strategy
              <br />
              meets the
              <span className="italic"> tape</span>.
            </h1>
            <p className="mt-5 max-w-xl text-[14px] leading-relaxed text-muted-foreground sm:text-[15px]">
              A quantitative trading workspace bridging backtest and live execution.
              Spin up a session, watch the engine evaluate sweeps in real time, drill
              into every trade with a tap, and reconcile against your broker on click.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <Link
                href="/lives"
                className="group inline-flex items-center gap-2 rounded-md bg-signal px-4 py-2.5 font-mono text-[11.5px] font-medium uppercase tracking-[0.18em] text-signal-foreground transition hover:bg-signal/90"
              >
                <Radio className="h-3.5 w-3.5" strokeWidth={2.5} />
                Live trading
                <span className="ml-1 inline-block h-1 w-1 rounded-full bg-signal-foreground/70 transition group-hover:bg-signal-foreground" />
              </Link>
              <Link
                href="/backtest/new"
                className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-4 py-2.5 font-mono text-[11.5px] uppercase tracking-[0.18em] text-foreground transition hover:border-border-strong hover:bg-muted"
              >
                <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
                New backtest
              </Link>
              <Link
                href="/backtest"
                className="inline-flex items-center gap-2 px-2 py-2 font-mono text-[11.5px] uppercase tracking-[0.18em] text-muted-foreground transition hover:text-foreground"
              >
                All runs
                <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.75} />
              </Link>
            </div>
          </div>

          {/* Live snapshot */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
            className="col-span-12 lg:col-span-5"
          >
            <LiveSnapshot
              isRunning={isRunning}
              equity={equityValue}
              activeSessionId={activeSession?.id ?? null}
              activeSessionMode={activeSession?.mode ?? null}
              activeSessionStartedAt={activeSession?.startedAt ?? null}
              totalRealized={totalRealized}
              winRate={liveWinRate}
              totalWins={totalWins}
              totalLosses={totalLosses}
            />
          </motion.div>
        </div>
      </Reveal>

      <div className="hairline" />

      {/* ─── Live trading section ───────────────────────────────────────── */}
      <Reveal as="section" delay={0.05}>
        <div className="flex items-end justify-between gap-3 pb-5">
          <div className="flex flex-col gap-1">
            <span className="label-eyebrow flex items-center gap-2">
              <span className="text-signal">◆</span>
              Section · 01 / Live trading
            </span>
            <h2 className="display-serif text-[28px] leading-tight tracking-tight sm:text-[32px]">
              The <span className="italic">tape</span>, in motion.
            </h2>
            <p className="font-mono text-[11px] tracking-wide text-muted-foreground">
              Trailing 7 days · {equityPoints.length} equity samples · {allSessions.length} sessions total
            </p>
          </div>
          <Link
            href="/lives"
            className="hidden items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground transition hover:text-foreground sm:inline-flex"
          >
            All sessions
            <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.75} />
          </Link>
        </div>

        <StaggerGroup className="grid grid-cols-12 gap-4">
          {/* Equity arc — large card */}
          <StaggerItem className="col-span-12 lg:col-span-8">
            <div className="rounded-md border border-border bg-card p-5">
              <div className="mb-4 flex items-end justify-between gap-3">
                <div>
                  <span className="label-eyebrow">Equity arc · 7d</span>
                  <div className="mt-1 flex items-baseline gap-3">
                    <span className="display-num text-[28px] tabular-nums tracking-tight">
                      {equityValue !== null ? (
                        <CountUp value={equityValue} prefix="$" decimals={2} />
                      ) : (
                        '—'
                      )}
                    </span>
                    <span
                      className={cn(
                        'font-mono text-[12px] tabular-nums',
                        sevenDayPnl > 0 ? 'text-profit' : sevenDayPnl < 0 ? 'text-loss' : 'text-muted-foreground',
                      )}
                    >
                      {sevenDayPnl >= 0 ? '+' : '−'}${Math.abs(sevenDayPnl).toFixed(2)} 7d
                    </span>
                  </div>
                </div>
              </div>
              <EquityCurve points={equityPoints} height={180} />
            </div>
          </StaggerItem>

          {/* 24h stats column */}
          <StaggerItem className="col-span-12 lg:col-span-4">
            <div className="grid h-full grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border lg:grid-cols-1">
              <SnapshotCell
                label="Trades · 24h"
                value={String(last24Trades)}
                tone="neutral"
              />
              <SnapshotCell
                label="P&L · 24h"
                value={`${last24Pnl >= 0 ? '+' : '−'}$${Math.abs(last24Pnl).toFixed(2)}`}
                tone={last24Pnl > 0 ? 'profit' : last24Pnl < 0 ? 'loss' : 'neutral'}
              />
              <SnapshotCell
                label="Sessions · 24h"
                value={String(recentSessions.length)}
                tone="neutral"
              />
              <SnapshotCell
                label="Total live trades"
                value={String(totalLiveTrades)}
                sub={`${totalWins}W · ${totalLosses}L`}
                tone="signal"
              />
            </div>
          </StaggerItem>
        </StaggerGroup>

        {/* Recent live trades */}
        <div className="mt-4 rounded-md border border-border bg-card">
          <header className="flex items-center justify-between border-b border-border px-5 py-3">
            <span className="label-eyebrow">Recent live trades</span>
            <Link
              href="/lives"
              className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground transition hover:text-foreground"
            >
              View all →
            </Link>
          </header>
          {(recentTrades.data?.trades?.length ?? 0) === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
              <span className="display-serif text-[28px] italic text-muted-foreground">—</span>
              <p className="text-[13px] text-muted-foreground">
                No live trades fired yet.{' '}
                <Link
                  href="/lives"
                  className="text-signal underline-offset-4 hover:underline"
                >
                  Open the cockpit
                </Link>{' '}
                to start a session.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border/50">
              {recentTrades.data?.trades?.map((t, i) => (
                <motion.div
                  key={t.id}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.1 + i * 0.05, duration: 0.4 }}
                  className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span
                      className={cn(
                        'font-mono text-[10px] uppercase tracking-[0.18em]',
                        t.side === 'BUY' ? 'text-profit' : 'text-loss',
                      )}
                    >
                      {t.side}
                    </span>
                    <span className="font-mono text-[12px]">{t.symbol}</span>
                    <span className="hidden font-mono text-[10px] text-muted-foreground sm:inline">
                      {t.lotSize.toFixed(2)} lot @{t.entryPrice.toFixed(5)}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span
                      className={cn(
                        'inline-block rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em]',
                        t.status === 'OPEN' && 'bg-signal/15 text-signal',
                        t.status === 'CLOSED' && 'bg-muted text-muted-foreground',
                        t.status === 'PENDING' && 'bg-warning/15 text-warning',
                      )}
                    >
                      {t.status}
                    </span>
                    <span
                      className={cn(
                        'font-mono text-[12px] tabular-nums',
                        t.pnl !== null && t.pnl >= 0 && 'text-profit',
                        t.pnl !== null && t.pnl < 0 && 'text-loss',
                        t.pnl === null && 'text-muted-foreground',
                      )}
                    >
                      {t.pnl !== null ? `${t.pnl >= 0 ? '+' : '−'}$${Math.abs(t.pnl).toFixed(2)}` : '—'}
                    </span>
                  </div>
                </motion.div>
              ))}
            </div>
          )}
        </div>
      </Reveal>

      <div className="hairline" />

      {/* ─── Strategy comparison ─────────────────────────────────────── */}
      <Reveal as="section" delay={0.1}>
        <div className="flex items-end justify-between gap-3 pb-5">
          <div className="flex flex-col gap-1">
            <span className="label-eyebrow flex items-center gap-2">
              <span className="text-signal">◆</span>
              Section · 02 / Strategies
            </span>
            <h2 className="display-serif text-[28px] leading-tight tracking-tight sm:text-[32px]">
              Three challengers, <span className="italic">one tape</span>.
            </h2>
          </div>
          <Link
            href="/backtest/new"
            className="hidden items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground transition hover:text-foreground sm:inline-flex"
          >
            Compare →
          </Link>
        </div>

        <StaggerGroup className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {aggregates.map((a) => {
            const meta = STRATEGY_META[a.strategy];
            return (
              <StaggerItem key={a.strategy}>
                <motion.div
                  whileHover={{ y: -2 }}
                  transition={{ duration: 0.2 }}
                  className="group relative flex h-full flex-col gap-4 rounded-md border border-border bg-card p-5 transition-colors hover:border-border-strong"
                >
                  <div className="flex items-start justify-between">
                    <StrategyBadge version={a.strategy} size="md" />
                    <span className="font-mono text-[10px] tabular-nums text-subtle">
                      {String(a.runs).padStart(2, '0')} run{a.runs === 1 ? '' : 's'}
                    </span>
                  </div>
                  <h3 className={cn('display-serif text-[22px] leading-tight tracking-tight', meta.hue)}>
                    {meta.blurb}
                  </h3>
                  <p className="text-[12.5px] leading-relaxed text-muted-foreground">
                    {meta.description}
                  </p>
                  <div className="mt-auto grid grid-cols-3 gap-3 border-t border-border pt-4">
                    <MetricChip
                      label="Avg Ret"
                      value={a.runs ? formatPct(a.avgReturn, 1) : '—'}
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
                </motion.div>
              </StaggerItem>
            );
          })}
        </StaggerGroup>
      </Reveal>

      <div className="hairline" />

      {/* ─── Recent backtest runs ───────────────────────────────────── */}
      <Reveal as="section" delay={0.15}>
        <div className="flex items-end justify-between gap-3 pb-5">
          <div className="flex flex-col gap-1">
            <span className="label-eyebrow flex items-center gap-2">
              <span className="text-signal">◆</span>
              Section · 03 / Backtests
            </span>
            <h2 className="display-serif text-[28px] leading-tight tracking-tight sm:text-[32px]">
              Recent runs.
            </h2>
            <p className="font-mono text-[11px] tracking-wide text-muted-foreground">
              {completed.length} completed · last {Math.min(8, runs.length)} shown
            </p>
          </div>
          <Link
            href="/backtest"
            className="hidden items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground transition hover:text-foreground sm:inline-flex"
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
              <span className="display-serif text-[28px] italic text-muted-foreground">—</span>
              <p className="max-w-md text-[13px] text-muted-foreground">
                Spin up a backtest to see strategies marked against the tape, trade-by-trade.
              </p>
              <Link
                href="/backtest/new"
                className="mt-2 inline-flex items-center gap-2 rounded-md bg-signal/10 px-4 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-signal ring-1 ring-inset ring-signal/30 transition hover:bg-signal hover:text-signal-foreground"
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
                  {runs.slice(0, 8).map((run, i) => {
                    const m = run.metrics;
                    const ret = m?.returnPercent ?? 0;
                    const isProfit = ret >= 0;
                    return (
                      <motion.tr
                        key={run.id}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 0.18 + i * 0.03, duration: 0.4 }}
                        className="row-hover transition-colors"
                      >
                        <Td>
                          <Link href={`/backtest/${run.id}`} className="flex items-center gap-2">
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
                        <Td align="right" className={cn('font-mono tnum', isProfit ? 'text-profit' : 'text-loss')}>
                          {m ? formatPct(ret) : '—'}
                        </Td>
                        <Td align="right">{m ? `${m.winRate.toFixed(1)}%` : '—'}</Td>
                        <Td align="right">{m ? formatRatio(m.profitFactor) : '—'}</Td>
                        <Td align="right">{m ? `${m.maxDrawdownPercent.toFixed(1)}%` : '—'}</Td>
                        <Td align="right">{m ? formatNum(m.totalTrades, 0) : '—'}</Td>
                      </motion.tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </Reveal>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────── */

function LiveSnapshot({
  isRunning,
  equity,
  activeSessionId,
  activeSessionMode,
  activeSessionStartedAt,
  totalRealized,
  winRate,
  totalWins,
  totalLosses,
}: {
  isRunning: boolean;
  equity: number | null;
  activeSessionId: string | null;
  activeSessionMode: string | null;
  activeSessionStartedAt: string | null;
  totalRealized: number;
  winRate: number;
  totalWins: number;
  totalLosses: number;
}) {
  return (
    <div className="relative h-full overflow-hidden rounded-md border border-border bg-card">
      <div className="absolute inset-0 grid-pattern opacity-20" />

      <div className="relative flex h-full flex-col gap-0">
        {/* Status header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <span className="label-eyebrow">
            <span className={cn('mr-1.5', isRunning ? 'text-signal' : 'text-muted-foreground')}>
              {isRunning ? '●' : '○'}
            </span>
            {isRunning ? 'Live · Engine running' : 'Live · Idle'}
          </span>
          {isRunning && activeSessionStartedAt && (
            <RunningClock since={activeSessionStartedAt} />
          )}
        </div>

        {/* Big equity */}
        <div className="px-5 pt-5 pb-3">
          <span className="label-eyebrow">Account equity</span>
          <div className="mt-1.5 display-num text-[44px] leading-none tracking-tight sm:text-[52px]">
            {equity !== null ? (
              <CountUp value={equity} prefix="$" decimals={2} />
            ) : (
              '—'
            )}
          </div>
          <div className="mt-2 flex items-center gap-3 font-mono text-[11px]">
            <span className="text-muted-foreground">
              Realized
              <span
                className={cn(
                  'ml-1.5 tabular-nums',
                  totalRealized > 0 ? 'text-profit' : totalRealized < 0 ? 'text-loss' : 'text-foreground',
                )}
              >
                {totalRealized >= 0 ? '+' : '−'}${Math.abs(totalRealized).toFixed(2)}
              </span>
            </span>
            <span className="text-subtle">·</span>
            <span className="text-muted-foreground">
              Win{' '}
              <span className="tabular-nums text-foreground">
                {totalWins + totalLosses > 0 ? `${winRate.toFixed(0)}%` : '—'}
              </span>
            </span>
          </div>
        </div>

        {/* Action / status bar */}
        <div className="mt-auto border-t border-border bg-background/40 px-5 py-3">
          {isRunning && activeSessionId ? (
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                  Active session
                </div>
                <div className="mt-0.5 font-mono text-[11.5px]">
                  {activeSessionId.slice(0, 8)} · {activeSessionMode?.toUpperCase()}
                </div>
              </div>
              <Link
                href={`/lives/${activeSessionId}`}
                className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-signal/30 bg-signal/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-signal transition hover:bg-signal/15"
              >
                <Zap className="h-3 w-3" />
                Open cockpit
              </Link>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <div className="font-mono text-[11px] text-muted-foreground">
                No active session
              </div>
              <Link
                href="/lives"
                className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-foreground transition hover:bg-muted"
              >
                <Plus className="h-3 w-3" strokeWidth={2.5} />
                Start one
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RunningClock({ since }: { since: string }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const ms = Date.now() - new Date(since).getTime();
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return (
    <span className="font-mono text-[11px] tabular-nums text-signal">
      {h > 0 && `${h}h `}{m}m {String(s).padStart(2, '0')}s
    </span>
  );
}

function SnapshotCell({
  label,
  value,
  sub,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'profit' | 'loss' | 'neutral' | 'signal';
}) {
  const colorClass =
    tone === 'profit'
      ? 'text-profit'
      : tone === 'loss'
        ? 'text-loss'
        : tone === 'signal'
          ? 'text-foreground'
          : 'text-foreground';
  return (
    <div className="bg-card px-4 py-4 sm:px-5">
      <div className="label-eyebrow text-[9px]">{label}</div>
      <div className={cn('mt-1.5 font-mono text-[20px] tabular-nums tracking-tight', colorClass)}>
        {value}
      </div>
      {sub && (
        <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          {sub}
        </div>
      )}
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

void Activity;
