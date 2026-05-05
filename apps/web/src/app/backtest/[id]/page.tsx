'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Loader2, AlertCircle } from 'lucide-react';
import { useBacktest } from '@/hooks/use-backtest';
import { useBacktestTrades } from '@/hooks/use-backtest-trades';
import { useBacktestCandles } from '@/hooks/use-backtest-candles';
import {
  buildEquityCurve,
  rDistribution,
  dailyPnL,
} from '@/lib/trade-stats';
import { strategyOf } from '@/lib/aggregate';
import { Panel } from '@/components/backtest/panel';
import { MetricChip } from '@/components/backtest/metric-chip';
import { StrategyBadge } from '@/components/backtest/strategy-badge';
import { StatusDot } from '@/components/backtest/status-dot';
import { BacktestChart } from '@/components/backtest/backtest-chart';
import { EquityCurveChart } from '@/components/backtest/equity-curve-chart';
import { DrawdownChart } from '@/components/backtest/drawdown-chart';
import { RDistribution } from '@/components/backtest/r-distribution';
import { DailyHeatmap } from '@/components/backtest/daily-heatmap';
import { ExitReasonBreakdown } from '@/components/backtest/exit-reason-breakdown';
import { SetupTagAttribution } from '@/components/backtest/setup-tag-attribution';
import { TradeTable } from '@/components/backtest/trade-table';
import {
  formatNum,
  formatPct,
  formatRatio,
  formatSignedMoney,
} from '@/components/backtest/value';
import { cn } from '@/lib/utils';

const TABS = ['chart', 'analytics', 'trades'] as const;
type Tab = (typeof TABS)[number];

export default function BacktestResultPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { data: backtest, isLoading } = useBacktest(id);
  const completed = backtest?.status === 'COMPLETED';
  const { data: trades } = useBacktestTrades(id, completed);
  const { data: candles } = useBacktestCandles(id, completed);
  const [tab, setTab] = useState<Tab>('chart');

  if (isLoading) {
    return (
      <div className="mx-auto flex max-w-[1500px] items-center justify-center py-32 font-mono text-[11px] text-subtle">
        Loading run…
      </div>
    );
  }

  if (!backtest) {
    return (
      <div className="mx-auto max-w-[1500px]">
        <Panel title="Run Not Found">
          <div className="flex items-center gap-3 text-loss">
            <AlertCircle className="h-4 w-4" />
            <span className="text-[13px]">
              No backtest matches{' '}
              <span className="font-mono">{id}</span>.
            </span>
          </div>
        </Panel>
      </div>
    );
  }

  const m = backtest.metrics;
  const ret = m?.returnPercent ?? 0;
  const isProfit = ret >= 0;
  const equityCurve =
    trades && trades.length > 0
      ? buildEquityCurve(trades, backtest.initialBalance)
      : [];
  const rDist = trades ? rDistribution(trades) : [];
  const daily = trades ? dailyPnL(trades, backtest.initialBalance) : [];

  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-6 pb-12">
      {/* Header */}
      <header className="flex flex-col gap-4 border-b border-border pb-5">
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <Link
            href="/backtest"
            className="inline-flex items-center gap-1 hover:text-foreground"
          >
            <ArrowLeft className="h-3 w-3" />
            Run Library
          </Link>
          <span className="text-subtle">/</span>
          <span className="font-mono">{backtest.id.slice(0, 8)}</span>
        </div>
        <div className="flex flex-col items-start justify-between gap-4 lg:flex-row lg:items-end">
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-3">
              <StatusDot status={backtest.status} />
              <StrategyBadge version={strategyOf(backtest)} size="md" />
              <span className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                {backtest.symbol}
              </span>
              <span className="font-mono text-[11px] text-subtle">
                ${formatNum(backtest.initialBalance, 0)} ·{' '}
                {backtest.riskPercent}% risk
              </span>
            </div>
            <h1 className="display-serif text-[28px] leading-[0.95] tracking-[0.04em] sm:text-[36px] lg:text-[40px]">
              {backtest.startDate.slice(0, 10)}{' '}
              <span className="text-subtle">→</span>{' '}
              {backtest.endDate.slice(0, 10)}
            </h1>
          </div>
          {/* Hero PnL */}
          {m && (
            <div className="frame-brackets relative grid grid-cols-2 gap-x-8 gap-y-3 border border-border bg-card px-6 py-4 sm:grid-cols-4">
              <MetricChip
                label="Return"
                value={formatPct(m.returnPercent)}
                tone={isProfit ? 'profit' : 'loss'}
                size="lg"
              />
              <MetricChip
                label="Win Rate"
                value={`${m.winRate.toFixed(1)}%`}
                tone="signal"
                size="lg"
              />
              <MetricChip
                label="Profit Fac"
                value={formatRatio(m.profitFactor)}
                tone={m.profitFactor >= 1.5 ? 'signal' : 'default'}
                size="lg"
              />
              <MetricChip
                label="Max DD"
                value={`${m.maxDrawdownPercent.toFixed(1)}%`}
                tone={m.maxDrawdownPercent < 10 ? 'profit' : 'loss'}
                size="lg"
              />
            </div>
          )}
        </div>
      </header>

      {backtest.status === 'PENDING' || backtest.status === 'RUNNING' ? (
        <Panel title="Run In Progress" brackets>
          <div className="flex flex-col items-center gap-4 py-16">
            <Loader2 className="h-7 w-7 animate-spin text-signal" strokeWidth={1.5} />
            <p className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              {backtest.status} — Streaming results…
            </p>
          </div>
        </Panel>
      ) : backtest.status === 'FAILED' ? (
        <Panel title="Run Failed" brackets>
          <div className="flex items-start gap-3 text-loss">
            <AlertCircle className="mt-0.5 h-4 w-4" />
            <p className="text-[13px] leading-relaxed">
              {backtest.errorMessage ?? 'An unknown error occurred.'}
            </p>
          </div>
        </Panel>
      ) : (
        <>
          {/* Secondary metrics row */}
          {m && (
            <Panel bodyClassName="px-4 py-4">
              <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4 lg:grid-cols-8">
                <MetricChip label="Trades" value={formatNum(m.totalTrades, 0)} />
                <MetricChip label="Wins" value={formatNum(m.winCount, 0)} tone="profit" />
                <MetricChip label="Losses" value={formatNum(m.lossCount, 0)} tone="loss" />
                <MetricChip label="BE" value={formatNum(m.breakevenCount, 0)} tone="neutral" />
                <MetricChip label="Avg RR" value={formatRatio(m.avgRR)} />
                <MetricChip label="Sharpe" value={formatRatio(m.sharpeRatio)} tone="signal" />
                <MetricChip
                  label="PnL"
                  value={formatSignedMoney(m.totalPnl, 0)}
                  tone={m.totalPnl >= 0 ? 'profit' : 'loss'}
                />
                <MetricChip
                  label="Final"
                  value={`$${formatNum(m.finalBalance, 0)}`}
                />
              </div>
            </Panel>
          )}

          {/* Tabs */}
          <div className="flex items-center gap-px border-b border-border">
            {TABS.map((t) => {
              const labels = {
                chart: 'Price',
                analytics: 'Analytics',
                trades: `Trades (${trades?.length ?? 0})`,
              };
              const active = tab === t;
              return (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={cn(
                    'group relative -mb-px border-b border-border px-4 py-2.5 font-mono text-[11px] uppercase tracking-widest transition-colors',
                    active
                      ? 'border-signal text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {active && (
                    <span className="absolute inset-x-0 -top-px h-px bg-signal" />
                  )}
                  {labels[t]}
                </button>
              );
            })}
          </div>

          {/* Tab content */}
          {tab === 'chart' && (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className="lg:col-span-3">
                <Panel
                  title="Price — M15"
                  count={candles?.length ?? 0}
                  subtitle={
                    <span className="font-mono text-[11px]">
                      {backtest.symbol} ·{' '}
                      <span className="text-foreground">
                        {trades?.length ?? 0} trades marked
                      </span>
                    </span>
                  }
                  bodyClassName="p-0"
                  brackets
                >
                  {candles && candles.length > 0 ? (
                    <BacktestChart candles={candles} trades={trades ?? []} />
                  ) : (
                    <div className="flex h-[520px] items-center justify-center font-mono text-[11px] text-subtle">
                      Loading candles…
                    </div>
                  )}
                </Panel>
              </div>
            </div>
          )}

          {tab === 'analytics' && (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Panel title="Equity Curve" brackets>
                {equityCurve.length > 1 ? (
                  <EquityCurveChart data={equityCurve} />
                ) : (
                  <div className="flex h-[220px] items-center justify-center font-mono text-[11px] text-subtle">
                    Not enough trades.
                  </div>
                )}
              </Panel>
              <Panel
                title="Drawdown Curve"
                subtitle={
                  <span className="font-mono text-[11px] tnum">
                    Max{' '}
                    <span className="text-loss">
                      {m ? `${m.maxDrawdownPercent.toFixed(1)}%` : '—'}
                    </span>
                  </span>
                }
              >
                {equityCurve.length > 1 ? (
                  <DrawdownChart data={equityCurve} />
                ) : (
                  <div className="flex h-[160px] items-center justify-center font-mono text-[11px] text-subtle">
                    Not enough trades.
                  </div>
                )}
              </Panel>

              <Panel
                title="R-Multiple Distribution"
                subtitle={
                  <span className="font-mono text-[11px] tnum">
                    Avg RR{' '}
                    <span className="text-foreground">
                      {m ? formatRatio(m.avgRR) : '—'}
                    </span>
                  </span>
                }
              >
                <RDistribution data={rDist} />
              </Panel>

              <Panel title="Exit Reason Breakdown">
                <ExitReasonBreakdown trades={trades ?? []} />
              </Panel>

              <Panel
                title="Daily PnL"
                className="lg:col-span-2"
                subtitle={
                  <span className="font-mono text-[11px] tnum">
                    {daily.length} active day
                    {daily.length === 1 ? '' : 's'} · GitHub-style calendar
                  </span>
                }
              >
                <DailyHeatmap
                  data={daily}
                  startDate={backtest.startDate}
                  endDate={backtest.endDate}
                />
              </Panel>

              <Panel
                title="Setup Tag Attribution"
                className="lg:col-span-2"
                subtitle={
                  <span className="font-mono text-[11px]">
                    Win rate &amp; PnL by setup tag
                  </span>
                }
                bodyClassName="p-0"
              >
                <SetupTagAttribution trades={trades ?? []} />
              </Panel>
            </div>
          )}

          {tab === 'trades' && (
            <Panel
              title="Trade Log"
              count={trades?.length ?? 0}
              bodyClassName="p-0 sm:p-4"
              brackets
            >
              <TradeTable trades={trades ?? []} />
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
