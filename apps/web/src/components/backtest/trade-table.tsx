'use client';

import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Search, X } from 'lucide-react';
import type { BacktestTrade } from '@/lib/types';
import { rMultiple } from '@/lib/trade-stats';
import { ExitReasonBadge } from './exit-reason-badge';
import { formatNum, formatSignedMoney } from './value';
import { cn } from '@/lib/utils';

type SortKey = 'entryTime' | 'pnl' | 'side' | 'exitReason' | 'r';
type SideFilter = 'all' | 'BUY' | 'SELL';
type OutcomeFilter = 'all' | 'win' | 'loss' | 'be';

export function TradeTable({ trades }: { trades: BacktestTrade[] }) {
  const [sortKey, setSortKey] = useState<SortKey>('entryTime');
  const [sortAsc, setSortAsc] = useState(true);
  const [side, setSide] = useState<SideFilter>('all');
  const [outcome, setOutcome] = useState<OutcomeFilter>('all');
  const [query, setQuery] = useState('');

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc(!sortAsc);
    else {
      setSortKey(key);
      setSortAsc(false); // default to desc on first click
    }
  }

  const enriched = useMemo(
    () => trades.map((t) => ({ ...t, r: rMultiple(t) })),
    [trades],
  );

  const filtered = enriched.filter((t) => {
    if (side !== 'all' && t.side !== side) return false;
    if (outcome === 'win' && t.pnl <= 0) return false;
    if (outcome === 'loss' && t.pnl >= 0) return false;
    if (outcome === 'be' && t.exitReason !== 'BREAKEVEN') return false;
    if (query) {
      const q = query.toLowerCase();
      if (
        !(t.setupTags ?? []).some((tag) => tag.toLowerCase().includes(q)) &&
        !t.exitReason.toLowerCase().includes(q) &&
        !t.h1Bias.toLowerCase().includes(q)
      )
        return false;
    }
    return true;
  });

  const sorted = filtered.sort((a, b) => {
    let cmp = 0;
    switch (sortKey) {
      case 'entryTime':
        cmp = new Date(a.entryTime).getTime() - new Date(b.entryTime).getTime();
        break;
      case 'pnl':
        cmp = a.pnl - b.pnl;
        break;
      case 'r':
        cmp = a.r - b.r;
        break;
      case 'side':
        cmp = a.side.localeCompare(b.side);
        break;
      case 'exitReason':
        cmp = a.exitReason.localeCompare(b.exitReason);
        break;
    }
    return sortAsc ? cmp : -cmp;
  });

  const wins = filtered.filter((t) => t.pnl > 0).length;
  const losses = filtered.filter((t) => t.pnl < 0).length;
  const be = filtered.filter((t) => t.exitReason === 'BREAKEVEN').length;
  const totalPnl = filtered.reduce((s, t) => s + t.pnl, 0);

  return (
    <div className="flex flex-col gap-3">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <FilterGroup label="Side">
          {(['all', 'BUY', 'SELL'] as const).map((s) => (
            <Pill key={s} active={side === s} onClick={() => setSide(s)}>
              {s === 'all' ? 'All' : s}
            </Pill>
          ))}
        </FilterGroup>
        <FilterGroup label="Outcome">
          {(['all', 'win', 'loss', 'be'] as const).map((s) => (
            <Pill key={s} active={outcome === s} onClick={() => setOutcome(s)}>
              {s === 'all'
                ? 'All'
                : s === 'win'
                ? 'Wins'
                : s === 'loss'
                ? 'Losses'
                : 'BE'}
            </Pill>
          ))}
        </FilterGroup>
        <div className="relative ml-auto w-full max-w-[260px] flex-1 min-w-[160px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
          <input
            type="text"
            placeholder="Search tags / reason…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-7 w-full border border-border bg-surface pl-8 pr-7 font-mono text-[11px] text-foreground placeholder:text-subtle focus:border-signal focus:outline-none"
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

      {/* Summary chips */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-border bg-surface/40 px-3 py-2 font-mono text-[10.5px] tracking-widest">
        <Chip label="Filtered" value={filtered.length.toString()} />
        <Chip
          label="Wins"
          value={String(wins)}
          tone="profit"
        />
        <Chip
          label="Losses"
          value={String(losses)}
          tone="loss"
        />
        <Chip label="BE" value={String(be)} tone="muted" />
        <span className="ml-auto flex items-center gap-2">
          <span className="text-muted-foreground">Σ&nbsp;PnL</span>
          <span
            className={cn(
              'tnum',
              totalPnl >= 0 ? 'text-profit' : 'text-loss',
            )}
          >
            {formatSignedMoney(totalPnl, 2)}
          </span>
        </span>
      </div>

      {/* Table */}
      <div className="overflow-x-auto border border-border">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b border-border bg-surface">
              <SortableTh
                onClick={() => toggleSort('entryTime')}
                active={sortKey === 'entryTime'}
                asc={sortAsc}
              >
                Entry Time
              </SortableTh>
              <SortableTh
                onClick={() => toggleSort('side')}
                active={sortKey === 'side'}
                asc={sortAsc}
              >
                Side
              </SortableTh>
              <Th align="right">Entry</Th>
              <Th align="right">Exit</Th>
              <Th align="right">SL</Th>
              <Th align="right">TP</Th>
              <Th align="right">Lot</Th>
              <SortableTh
                onClick={() => toggleSort('r')}
                active={sortKey === 'r'}
                asc={sortAsc}
                align="right"
              >
                R
              </SortableTh>
              <SortableTh
                onClick={() => toggleSort('pnl')}
                active={sortKey === 'pnl'}
                asc={sortAsc}
                align="right"
              >
                PnL
              </SortableTh>
              <SortableTh
                onClick={() => toggleSort('exitReason')}
                active={sortKey === 'exitReason'}
                asc={sortAsc}
              >
                Exit
              </SortableTh>
              <Th>H1 Bias</Th>
              <Th>Setup Tags</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {sorted.length === 0 && (
              <tr>
                <td
                  colSpan={12}
                  className="px-3 py-8 text-center font-mono text-[11px] text-subtle"
                >
                  No trades match the current filters.
                </td>
              </tr>
            )}
            {sorted.map((trade) => {
              const isProfit = trade.pnl > 0;
              const dt = new Date(trade.entryTime);
              return (
                <tr key={trade.id} className="row-hover">
                  <Td>
                    <span className="text-muted-foreground">
                      {dt.toISOString().slice(0, 10)}
                    </span>
                    <span className="ml-2 text-foreground">
                      {dt.toISOString().slice(11, 16)}
                    </span>
                  </Td>
                  <Td>
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 font-mono text-[11px] uppercase tracking-widest',
                        trade.side === 'BUY' ? 'text-profit' : 'text-loss',
                      )}
                    >
                      <span
                        aria-hidden
                        className="font-mono text-[14px] leading-none"
                      >
                        {trade.side === 'BUY' ? '▲' : '▼'}
                      </span>
                      {trade.side}
                    </span>
                  </Td>
                  <Td align="right">{formatNum(trade.entryPrice, 2)}</Td>
                  <Td align="right">{formatNum(trade.exitPrice, 2)}</Td>
                  <Td align="right" className="text-loss/80">
                    {formatNum(trade.slPrice, 2)}
                  </Td>
                  <Td align="right" className="text-profit/80">
                    {formatNum(trade.tpPrice, 2)}
                  </Td>
                  <Td align="right">{formatNum(trade.lotSize, 2)}</Td>
                  <Td
                    align="right"
                    className={cn(
                      isProfit ? 'text-profit' : trade.pnl < 0 ? 'text-loss' : 'text-muted-foreground',
                    )}
                  >
                    {trade.r >= 0 ? '+' : ''}
                    {trade.r.toFixed(2)}
                  </Td>
                  <Td
                    align="right"
                    className={cn(
                      'font-medium',
                      isProfit ? 'text-profit' : trade.pnl < 0 ? 'text-loss' : 'text-muted-foreground',
                    )}
                  >
                    {formatSignedMoney(trade.pnl, 2)}
                  </Td>
                  <Td>
                    <ExitReasonBadge reason={trade.exitReason} />
                  </Td>
                  <Td>
                    <span className="text-[10.5px] uppercase tracking-widest text-muted-foreground">
                      {trade.h1Bias}
                    </span>
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {(trade.setupTags ?? []).slice(0, 5).map((tag) => (
                        <span
                          key={tag}
                          className="border border-border bg-surface px-1.5 py-px font-mono text-[9.5px] tracking-widest text-muted-foreground"
                        >
                          {tag}
                        </span>
                      ))}
                      {(trade.setupTags ?? []).length > 5 && (
                        <span className="font-mono text-[9.5px] text-subtle">
                          +{trade.setupTags.length - 5}
                        </span>
                      )}
                    </div>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
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

function Pill({
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
        '-ml-px flex items-center gap-1.5 border border-border px-2 py-0.5 font-mono text-[10.5px] uppercase tracking-widest first:ml-0',
        active
          ? 'border-signal/60 bg-signal/10 text-signal'
          : 'bg-surface text-muted-foreground hover:border-border-strong hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

function Chip({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'profit' | 'loss' | 'muted' | 'default';
}) {
  const colors = {
    profit: 'text-profit',
    loss: 'text-loss',
    muted: 'text-muted-foreground',
    default: 'text-foreground',
  };
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn('tnum', colors[tone])}>{value}</span>
    </span>
  );
}

function SortableTh({
  children,
  onClick,
  active,
  asc,
  align = 'left',
}: {
  children: React.ReactNode;
  onClick: () => void;
  active: boolean;
  asc: boolean;
  align?: 'left' | 'right';
}) {
  return (
    <th
      onClick={onClick}
      className={cn(
        'label-eyebrow cursor-pointer select-none whitespace-nowrap px-3 py-2.5',
        align === 'right' ? 'text-right' : 'text-left',
        active && 'text-foreground',
      )}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {active ? (
          asc ? (
            <ArrowUp className="h-3 w-3" strokeWidth={1.75} />
          ) : (
            <ArrowDown className="h-3 w-3" strokeWidth={1.75} />
          )
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-30" strokeWidth={1.75} />
        )}
      </span>
    </th>
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
        'whitespace-nowrap px-3 py-2 font-mono tabular-nums',
        align === 'right' ? 'text-right' : 'text-left',
        className,
      )}
    >
      {children}
    </td>
  );
}
