'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, RefreshCw, RotateCw, Square } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, LivePosition, LiveTrade } from '@/lib/api-client';
import { LiveDot, formatDuration } from '@/components/live/live-dot';
import { EquityCurve } from '@/components/live/equity-curve';
import { EquityTile } from '@/components/live/equity-tile';
import { CandleChart } from '@/components/live/candle-chart';
import { PositionsTable } from '@/components/live/positions-table';
import { StatsGrid } from '@/components/live/stats-grid';
import { TestTradeButton } from '@/components/live/test-trade-button';
import { LoopHealthPill } from '@/components/live/loop-health-pill';
import { Reveal, StaggerGroup, StaggerItem } from '@/components/motion/reveal';
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';

const PAIRS = ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY'];

export default function LiveDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const qc = useQueryClient();
  const router = useRouter();
  const [pair, setPair] = useState<string>('EURUSD');

  const liveQueryOpts = {
    refetchIntervalInBackground: true as const,
    retry: 3 as const,
    retryDelay: 1000,
  };

  const session = useQuery({
    queryKey: ['live-session', id],
    queryFn: () => api.liveSession(id),
    refetchInterval: 5000,
    ...liveQueryOpts,
  });

  const status = useQuery({
    queryKey: ['live-status'],
    queryFn: () => api.liveStatus(),
    refetchInterval: 5000,
    ...liveQueryOpts,
  });

  const trades = useQuery({
    queryKey: ['session-trades', id],
    queryFn: () => api.liveSessionTrades(id),
    refetchInterval: 10_000,
    ...liveQueryOpts,
  });

  const stats = useQuery({
    queryKey: ['session-stats', id],
    queryFn: () => api.liveSessionStats(id),
    refetchInterval: 30_000,
    ...liveQueryOpts,
  });

  const equityHistory = useQuery({
    queryKey: ['session-equity-history', id],
    queryFn: () => api.liveEquityHistoryForSession(id),
    refetchInterval: 60_000,
    ...liveQueryOpts,
  });

  const positions = useQuery({
    queryKey: ['live-positions'],
    queryFn: () => api.livePositions(),
    refetchInterval: (q) => {
      const data = q.state.data as { positions?: LivePosition[] } | undefined;
      const open = data?.positions?.length ?? 0;
      return open > 0 ? 2000 : 10_000;
    },
    enabled: session.data?.session?.status === 'RUNNING',
    ...liveQueryOpts,
  });

  const candles = useQuery({
    queryKey: ['live-candles', pair],
    queryFn: () => api.liveCandles(pair, 'M15', 120),
    refetchInterval: 30_000,
    ...liveQueryOpts,
  });

  const stopMut = useMutation({
    mutationFn: () => api.liveStop(),
    onSuccess: () => qc.invalidateQueries(),
  });

  const reconcileMut = useMutation({
    mutationFn: () => api.liveReconcile(),
    onSuccess: () => qc.invalidateQueries(),
  });

  const s = session.data?.session;

  if (session.isLoading) {
    return (
      <div className="py-20 text-center font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
        Loading session…
      </div>
    );
  }

  if (!s) {
    return (
      <div className="space-y-6">
        <Link
          href="/lives"
          className="inline-flex items-center gap-2 text-[12px] text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <span className="font-mono uppercase tracking-[0.18em]">All sessions</span>
        </Link>
        <div className="rounded-md border border-border bg-card p-12 text-center">
          <div className="display-serif text-[40px] italic text-muted-foreground">—</div>
          <p className="mt-3 text-sm text-muted-foreground">Session not found</p>
        </div>
      </div>
    );
  }

  const isRunning = s.status === 'RUNNING';
  const isThisActive = isRunning && status.data?.running;
  const endTime = s.endedAt ? new Date(s.endedAt).getTime() : Date.now();
  const duration = endTime - new Date(s.startedAt).getTime();

  return (
    <div className="space-y-6 lg:space-y-8">
      {/* ─── Back link ─── */}
      <Link
        href="/lives"
        className="inline-flex items-center gap-2 text-[12px] text-muted-foreground transition hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        <span className="font-mono uppercase tracking-[0.18em]">All sessions</span>
      </Link>

      {/* ─── Hero ─── */}
      <Reveal as="section">
        {/* Eyebrow row — mobile: ID left, status pills right (wrap if needed) */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="label-eyebrow">Session · {s.id.slice(0, 8)}</span>
          <div className="relative flex flex-wrap items-center gap-2">
            <LoopHealthPill />
            <LiveDot
              running={isRunning}
              since={isRunning ? s.startedAt : null}
            />
          </div>
        </div>

        {/* Headline */}
        <h1 className="mt-4 display-serif text-[36px] leading-[0.95] tracking-tight sm:text-[48px] lg:text-[60px]">
          <span className={cn('italic', isRunning ? 'text-signal' : 'text-muted-foreground')}>
            {isRunning ? 'Live' : s.status === 'CRASHED' ? 'Crashed' : 'Closed'}
          </span>{' '}
          session
        </h1>
        <p className="mt-3 break-words font-mono text-[11px] uppercase leading-relaxed tracking-[0.16em] text-muted-foreground">
          {s.strategyVersion} · {s.mode} · {s.riskPercent}% risk
          <span className="mx-1.5 text-subtle">·</span>
          {new Date(s.startedAt).toLocaleString()}
          {s.endedAt && (
            <>
              <span className="mx-1.5 text-subtle">→</span>
              {new Date(s.endedAt).toLocaleString()}
            </>
          )}
        </p>

        {/* Action row — separate row, full-width responsive */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            onClick={() => reconcileMut.mutate()}
            disabled={reconcileMut.isPending}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50"
            title="Sync DB trades with broker"
          >
            <RotateCw className={cn('h-3 w-3', reconcileMut.isPending && 'animate-spin')} />
            <span>Reconcile</span>
          </button>
          {isThisActive && (
            <>
              <TestTradeButton />
              <button
                onClick={() => stopMut.mutate()}
                disabled={stopMut.isPending}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-loss/15 px-3 py-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-loss ring-1 ring-inset ring-loss/30 transition hover:bg-loss/25 disabled:opacity-50 sm:ml-auto"
              >
                <Square className="h-3 w-3" strokeWidth={2.5} />
                <span className="hidden sm:inline">Stop session</span>
                <span className="sm:hidden">Stop</span>
              </button>
            </>
          )}
        </div>

        {/* Editorial stat strip — staggered */}
        <StaggerGroup className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-3 lg:grid-cols-6">
          <StaggerItem><StatCell label="Status" value={s.status} mono /></StaggerItem>
          <StaggerItem><StatCell label="Duration" value={formatDuration(duration)} mono /></StaggerItem>
          <StaggerItem><StatCell label="Mode" value={s.mode.toUpperCase()} mono /></StaggerItem>
          <StaggerItem><StatCell label="Risk" value={`${s.riskPercent}%`} mono /></StaggerItem>
          <StaggerItem><StatCell label="Start equity" value={`$${s.startEquity.toFixed(2)}`} mono /></StaggerItem>
          <StaggerItem>
            <StatCell
              label={s.endEquity !== null ? 'End equity' : 'Current equity'}
              value={
                s.endEquity !== null
                  ? `$${s.endEquity.toFixed(2)}`
                  : status.data?.account?.equity !== undefined &&
                      status.data.account?.equity !== null
                    ? `$${status.data.account.equity.toFixed(2)}`
                    : '—'
              }
              mono
              highlight
            />
          </StaggerItem>
        </StaggerGroup>
      </Reveal>

      {/* ─── Equity overview ─── */}
      <Reveal as="section" delay={0.08}>
        <div className="grid gap-4 lg:grid-cols-3">
          {isRunning && (
            <div className="lg:col-span-1">
              <EquityTile
                balance={status.data?.account?.balance ?? null}
                equity={status.data?.account?.equity ?? null}
                openPositions={positions.data?.positions ?? []}
                mode={s.mode}
                running={isThisActive ?? false}
                startEquity={s.startEquity}
              />
            </div>
          )}
          <div className={cn(isRunning ? 'lg:col-span-2' : 'lg:col-span-3')}>
            <Panel
              eyebrow="Equity curve · session window"
              subtitle={
                s.endedAt
                  ? `${equityHistory.data?.points.length ?? 0} samples · ${new Date(s.startedAt).toLocaleTimeString()} → ${new Date(s.endedAt).toLocaleTimeString()}`
                  : `${equityHistory.data?.points.length ?? 0} samples · ongoing`
              }
            >
              <EquityCurve points={equityHistory.data?.points ?? []} height={isRunning ? 160 : 220} />
            </Panel>
          </div>
        </div>
      </Reveal>

      {/* ─── Performance ─── */}
      <Reveal as="section" delay={0.16}>
        <Panel eyebrow="Performance · session" subtitle="Stats limited to this session">
          <StatsGrid stats={stats.data} />
        </Panel>
      </Reveal>

      {/* ─── Open positions (only running) ─── */}
      {isRunning && (
        <Reveal as="section" delay={0.22}>
          <Panel eyebrow="Open positions" subtitle="Polled every 2s while open">
            <PositionsTable positions={positions.data?.positions ?? []} />
          </Panel>
        </Reveal>
      )}

      {/* ─── Pair charts ─── */}
      <Reveal as="section" delay={0.22}>
        <Panel
          eyebrow="Pair charts · live"
          subtitle="120 M15 candles · auto-refresh 30s"
          right={
            <button
              onClick={() => candles.refetch()}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground transition hover:bg-muted hover:text-foreground"
            >
              <RefreshCw className={cn('h-3 w-3', candles.isFetching && 'animate-spin')} />
              <span className="hidden sm:inline">Refresh</span>
            </button>
          }
        >
          <div className="mb-3 flex flex-wrap gap-1.5">
            {PAIRS.map((p) => (
              <button
                key={p}
                onClick={() => setPair(p)}
                className={cn(
                  'rounded-md border px-3 py-1.5 font-mono text-[11px] tracking-wide transition',
                  pair === p
                    ? 'border-signal bg-signal/10 text-foreground'
                    : 'border-border text-muted-foreground hover:border-signal/40 hover:text-foreground',
                )}
              >
                {p}
              </button>
            ))}
          </div>
          <CandleChart
            symbol={pair}
            candles={candles.data?.candles ?? []}
            loading={candles.isLoading}
            error={
              candles.data?.error ??
              (candles.isError ? (candles.error as Error)?.message ?? 'fetch failed' : null)
            }
          />
        </Panel>
      </Reveal>

      {/* ─── Trades ─── */}
      <Reveal as="section" delay={0.28}>
        <Panel
          eyebrow={`Trades · this session`}
          subtitle={`${trades.data?.trades.length ?? 0} total`}
        >
          <SessionTradesTable trades={trades.data?.trades ?? []} />
        </Panel>
      </Reveal>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────── */

function Panel({
  eyebrow,
  subtitle,
  right,
  children,
}: {
  eyebrow: string;
  subtitle?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-border bg-card">
      <header className="flex items-baseline justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <div className="label-eyebrow">{eyebrow}</div>
          {subtitle && (
            <div className="mt-0.5 truncate font-mono text-[11px] tracking-wide text-muted-foreground">
              {subtitle}
            </div>
          )}
        </div>
        {right && <div className="flex shrink-0 items-center gap-2">{right}</div>}
      </header>
      <div className="p-4 sm:p-5">{children}</div>
    </div>
  );
}

function StatCell({
  label,
  value,
  mono,
  highlight,
}: {
  label: string;
  value: string;
  mono?: boolean;
  highlight?: boolean;
}) {
  return (
    <div className={cn('bg-card px-3 py-3 sm:px-4 sm:py-3.5', highlight && 'bg-signal/[0.04]')}>
      <div className="label-eyebrow text-[9px]">{label}</div>
      <div className={cn('mt-1.5 text-[13px] sm:text-[14px]', mono && 'font-mono tabular-nums')}>
        {value}
      </div>
    </div>
  );
}

function SessionTradesTable({ trades }: { trades: LiveTrade[] }) {
  if (trades.length === 0) {
    return (
      <div className="py-12 text-center">
        <div className="display-serif text-[28px] italic text-muted-foreground">—</div>
        <p className="mt-2 text-sm text-muted-foreground">No trades fired during this session</p>
      </div>
    );
  }

  return (
    <>
      {/* Desktop table */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-left font-mono text-[11px]">
          <thead className="border-b border-border text-muted-foreground">
            <tr>
              <Th>Opened</Th>
              <Th>Symbol</Th>
              <Th>Side</Th>
              <Th align="right">Lot</Th>
              <Th align="right">Entry</Th>
              <Th align="right">SL / TP</Th>
              <Th align="right">Exit</Th>
              <Th>Status</Th>
              <Th align="right">P&amp;L</Th>
              <Th>Closed</Th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t, i) => (
              <motion.tr
                key={t.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.04 * i, duration: 0.3 }}
                className="row-hover border-b border-border/40"
              >
                <Td>{new Date(t.createdAt).toLocaleString()}</Td>
                <Td>{t.symbol}</Td>
                <Td className={t.side === 'BUY' ? 'text-profit' : 'text-loss'}>{t.side}</Td>
                <Td align="right">{t.lotSize.toFixed(2)}</Td>
                <Td align="right">{t.entryPrice.toFixed(5)}</Td>
                <Td align="right" className="text-muted-foreground">
                  {t.slPrice.toFixed(5)} / {t.tpPrice.toFixed(5)}
                </Td>
                <Td align="right">{t.closePrice ? t.closePrice.toFixed(5) : '—'}</Td>
                <Td>
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'inline-block rounded px-1.5 py-0.5 text-[9px] uppercase tracking-[0.14em]',
                        t.status === 'OPEN' && 'bg-signal/15 text-signal',
                        t.status === 'CLOSED' && 'bg-muted text-muted-foreground',
                        t.status === 'PENDING' && 'bg-warning/15 text-warning',
                      )}
                    >
                      {t.status}
                    </span>
                    {t.exitReason && (
                      <span className="font-mono text-[9px] text-muted-foreground">
                        {t.exitReason}
                      </span>
                    )}
                  </div>
                </Td>
                <Td
                  align="right"
                  className={cn(
                    'font-medium',
                    t.pnl !== null && t.pnl >= 0 && 'text-profit',
                    t.pnl !== null && t.pnl < 0 && 'text-loss',
                  )}
                >
                  {t.pnl !== null ? `${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)}` : '—'}
                </Td>
                <Td className="text-muted-foreground">
                  {t.closedAt ? new Date(t.closedAt).toLocaleTimeString() : '—'}
                </Td>
              </motion.tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <StaggerGroup className="flex flex-col gap-2 md:hidden">
        {trades.map((t) => (
          <StaggerItem
            key={t.id}
            className={cn(
              'rounded-md border bg-background p-3',
              t.status === 'OPEN'
                ? 'border-signal/30 bg-signal/[0.03]'
                : 'border-border',
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[12px]">{t.symbol}</span>
                  <span
                    className={cn(
                      'font-mono text-[10px] uppercase tracking-[0.16em]',
                      t.side === 'BUY' ? 'text-profit' : 'text-loss',
                    )}
                  >
                    {t.side}
                  </span>
                  <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                    {t.lotSize.toFixed(2)} lot
                  </span>
                </div>
                <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                  {new Date(t.createdAt).toLocaleString()}
                </div>
              </div>
              <div className="text-right">
                <div
                  className={cn(
                    'font-mono text-[16px] tabular-nums tracking-tight',
                    t.pnl !== null && t.pnl >= 0 && 'text-profit',
                    t.pnl !== null && t.pnl < 0 && 'text-loss',
                  )}
                >
                  {t.pnl !== null ? `${t.pnl >= 0 ? '+' : '−'}$${Math.abs(t.pnl).toFixed(2)}` : '—'}
                </div>
                <div className="mt-0.5">
                  <span
                    className={cn(
                      'inline-block rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em]',
                      t.status === 'OPEN' && 'bg-signal/15 text-signal',
                      t.status === 'CLOSED' && 'bg-muted text-muted-foreground',
                    )}
                  >
                    {t.status}
                    {t.exitReason && ` · ${t.exitReason}`}
                  </span>
                </div>
              </div>
            </div>
            <div className="mt-2.5 grid grid-cols-3 gap-2 border-t border-border/40 pt-2 font-mono text-[10px] tabular-nums">
              <div>
                <div className="text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
                  Entry
                </div>
                <div>{t.entryPrice.toFixed(5)}</div>
              </div>
              <div>
                <div className="text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
                  SL
                </div>
                <div className="text-muted-foreground">{t.slPrice.toFixed(5)}</div>
              </div>
              <div>
                <div className="text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
                  TP
                </div>
                <div className="text-muted-foreground">{t.tpPrice.toFixed(5)}</div>
              </div>
            </div>
          </StaggerItem>
        ))}
      </StaggerGroup>
    </>
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
        'px-3 py-2.5 font-normal text-[10px] uppercase tracking-[0.16em]',
        align === 'right' && 'text-right',
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
      className={cn('px-3 py-2 tabular-nums', align === 'right' && 'text-right', className)}
    >
      {children}
    </td>
  );
}
