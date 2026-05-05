'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Plus, Search, X } from 'lucide-react';
import { useBacktests } from '@/hooks/use-backtests';
import { Panel } from '@/components/backtest/panel';
import { StatusDot } from '@/components/backtest/status-dot';
import { StrategyBadge } from '@/components/backtest/strategy-badge';
import { Sparkline } from '@/components/backtest/sparkline';
import {
  formatNum,
  formatPct,
  formatRatio,
} from '@/components/backtest/value';
import {
  strategyOf,
  syntheticEquityCurve,
} from '@/lib/aggregate';
import type { StrategyVersion } from '@/lib/types';
import { cn } from '@/lib/utils';

const STRATEGIES: ('all' | StrategyVersion)[] = [
  'all',
  'V5.5b',
  'V6',
  'V6-alt',
];

export default function BacktestListPage() {
  const { data: runs = [], isLoading } = useBacktests();
  const [strategy, setStrategy] = useState<'all' | StrategyVersion>('all');
  const [symbol, setSymbol] = useState<string>('all');
  const [query, setQuery] = useState('');

  const symbols = useMemo(() => {
    return Array.from(new Set(runs.map((r) => r.symbol))).sort();
  }, [runs]);

  const filtered = runs.filter((r) => {
    if (strategy !== 'all' && strategyOf(r) !== strategy) return false;
    if (symbol !== 'all' && r.symbol !== symbol) return false;
    if (query) {
      const q = query.toLowerCase();
      if (
        !r.id.toLowerCase().includes(q) &&
        !r.symbol.toLowerCase().includes(q)
      )
        return false;
    }
    return true;
  });

  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-6 pb-12">
      {/* Header */}
      <header className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1.5">
          <span className="label-eyebrow">
            <span className="text-signal">◆</span>&nbsp;Run Library
          </span>
          <h1 className="display-serif text-[32px] leading-[0.95] tracking-[0.04em] sm:text-[40px]">
            All <span className="text-signal">backtests</span>.
          </h1>
          <p className="text-[13px] text-muted-foreground">
            {runs.length} run{runs.length === 1 ? '' : 's'} across{' '}
            {symbols.length} symbol{symbols.length === 1 ? '' : 's'}.
          </p>
        </div>
        <Link
          href="/backtest/new"
          className="inline-flex w-fit items-center gap-2 border border-foreground bg-foreground px-4 py-2 text-[12px] font-medium uppercase tracking-widest text-background transition-colors hover:border-signal hover:bg-signal hover:text-signal-foreground"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
          New Run
        </Link>
      </header>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <FilterGroup label="Strategy">
          {STRATEGIES.map((s) => (
            <FilterPill
              key={s}
              active={strategy === s}
              onClick={() => setStrategy(s)}
            >
              {s === 'all' ? 'All' : s}
            </FilterPill>
          ))}
        </FilterGroup>
        {symbols.length > 1 && (
          <FilterGroup label="Symbol">
            <FilterPill active={symbol === 'all'} onClick={() => setSymbol('all')}>
              All
            </FilterPill>
            {symbols.map((s) => (
              <FilterPill
                key={s}
                active={symbol === s}
                onClick={() => setSymbol(s)}
              >
                {s}
              </FilterPill>
            ))}
          </FilterGroup>
        )}
        <div className="relative ml-auto w-full max-w-[280px] flex-1 min-w-[180px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
          <input
            type="text"
            placeholder="Search id / symbol…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 w-full border border-border bg-surface pl-8 pr-7 font-mono text-[12px] text-foreground placeholder:text-subtle focus:border-signal focus:outline-none"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-subtle hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      <Panel
        title="Run Inventory"
        count={filtered.length}
        bodyClassName="p-0"
        brackets
      >
        {isLoading && (
          <div className="px-4 py-8 text-center text-[12px] text-muted-foreground">
            Loading…
          </div>
        )}
        {!isLoading && filtered.length === 0 && (
          <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
            <span className="font-mono text-[10px] uppercase tracking-widest text-subtle">
              ── No matching runs ──
            </span>
            <p className="max-w-md text-[13px] text-muted-foreground">
              {runs.length === 0
                ? 'Spin up a backtest to populate the library.'
                : 'Adjust the filters above or clear the search.'}
            </p>
          </div>
        )}
        {filtered.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-b border-border bg-surface">
                  <Th>Run</Th>
                  <Th>Strategy</Th>
                  <Th>Symbol</Th>
                  <Th>Period</Th>
                  <Th align="right">Init Bal</Th>
                  <Th align="right">Risk%</Th>
                  <Th align="right">Equity</Th>
                  <Th align="right">PnL</Th>
                  <Th align="right">Win%</Th>
                  <Th align="right">PF</Th>
                  <Th align="right">DD</Th>
                  <Th align="right">Sharpe</Th>
                  <Th align="right">Trades</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {filtered.map((run) => {
                  const m = run.metrics;
                  const ret = m?.returnPercent ?? 0;
                  const isProfit = ret >= 0;
                  return (
                    <tr key={run.id} className="row-hover cursor-pointer">
                      <Td>
                        <Link
                          href={`/backtest/${run.id}`}
                          className="flex items-center gap-2 hover:text-signal"
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
                      <Td>
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {run.startDate.slice(0, 10)} → {run.endDate.slice(0, 10)}
                        </span>
                      </Td>
                      <Td align="right">
                        <span className="text-muted-foreground">
                          ${formatNum(run.initialBalance, 0)}
                        </span>
                      </Td>
                      <Td align="right">
                        <span className="text-muted-foreground">
                          {run.riskPercent}%
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
                        {m ? formatRatio(m.sharpeRatio) : '—'}
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
    </div>
  );
}

function FilterGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="label-eyebrow">{label}</span>
      <div className="flex items-center">{children}</div>
    </div>
  );
}

function FilterPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        '-ml-px flex items-center gap-1.5 border border-border px-2.5 py-1 font-mono text-[11px] uppercase tracking-widest first:ml-0',
        active
          ? 'border-signal/60 bg-signal/10 text-signal'
          : 'bg-surface text-muted-foreground hover:border-border-strong hover:text-foreground',
      )}
    >
      {children}
    </button>
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
