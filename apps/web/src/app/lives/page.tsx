'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ChevronRight,
  Play,
  Plus,
  TrendingUp as TrendingUpIcon,
  Zap,
  Sparkles,
} from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { api, LiveSession } from '@/lib/api-client';
import { LiveDot, formatDuration } from '@/components/live/live-dot';
import { EquityCurve } from '@/components/live/equity-curve';
import { StartLiveDialog, StartConfig } from '@/components/live/start-dialog';
import { Reveal, StaggerGroup, StaggerItem } from '@/components/motion/reveal';
import { CountUp } from '@/components/motion/count-up';
import { cn } from '@/lib/utils';

export default function LivesOverviewPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = useState(false);

  const liveQueryOpts = {
    refetchIntervalInBackground: true as const,
    retry: 3 as const,
    retryDelay: 1000,
  };

  const status = useQuery({
    queryKey: ['live-status'],
    queryFn: () => api.liveStatus(),
    refetchInterval: 5000,
    ...liveQueryOpts,
  });

  const sessions = useQuery({
    queryKey: ['live-sessions'],
    queryFn: () => api.liveSessions(50),
    refetchInterval: 10_000,
    ...liveQueryOpts,
  });

  const equityHistory = useQuery({
    queryKey: ['live-equity-aggregate'],
    queryFn: () => api.liveEquityHistory(168),
    refetchInterval: 60_000,
    ...liveQueryOpts,
  });

  const startMut = useMutation({
    mutationFn: (cfg: StartConfig) => api.liveStart(cfg),
    onSuccess: async () => {
      await qc.invalidateQueries();
      const list = await api.liveSessions(1);
      const newest = list.sessions[0];
      if (newest) router.push(`/lives/${newest.id}`);
    },
  });

  const isRunning = status.data?.running === true;
  const isEnabled = status.data?.enabled === true;

  // Aggregate stats across ALL closed sessions
  const allSessions = sessions.data?.sessions ?? [];
  const closedSessions = allSessions.filter((s) => s.status !== 'RUNNING');
  const totalSessions = allSessions.length;
  const totalRealized = closedSessions.reduce((s, x) => s + (x.realizedPnl ?? 0), 0);
  const totalTrades = closedSessions.reduce((s, x) => s + (x.tradesCount ?? 0), 0);
  const totalWins = closedSessions.reduce((s, x) => s + (x.winsCount ?? 0), 0);
  const totalLosses = closedSessions.reduce((s, x) => s + (x.lossesCount ?? 0), 0);
  const winRate = totalWins + totalLosses > 0 ? (totalWins / (totalWins + totalLosses)) * 100 : 0;
  const equity = status.data?.account?.equity ?? null;

  return (
    <div className="space-y-6 lg:space-y-8">
      {/* ─── Editorial Hero ─── */}
      <Reveal as="section">
        <div className="flex items-baseline justify-between gap-3 pb-1">
          <span className="label-eyebrow">Section · 01 / Sessions</span>
          <LiveDot
            running={isRunning}
            since={status.data?.lastChangedAt ?? null}
          />
        </div>

        <div className="grid gap-6 pt-4 lg:grid-cols-12 lg:gap-8">
          {/* Headline + CTA */}
          <div className="lg:col-span-5">
            <h1 className="display-serif text-[44px] leading-[0.95] tracking-tight sm:text-[56px] lg:text-[68px]">
              Live <span className="italic text-signal">trading</span>
              <br />
              sessions
            </h1>
            <p className="mt-4 max-w-md text-[14px] leading-relaxed text-muted-foreground sm:text-[15px]">
              Each <span className="font-mono text-foreground">Start → Stop</span> cycle is recorded
              as its own session, with isolated equity curve, trade list, and stats. Open any row
              to drill into the cockpit.
            </p>

            <div className="mt-6 flex items-center gap-3">
              <button
                onClick={() => setDialogOpen(true)}
                disabled={!isEnabled || isRunning}
                className="group relative inline-flex items-center gap-2 overflow-hidden rounded-md bg-signal px-5 py-2.5 text-[13px] font-medium tracking-wide text-signal-foreground transition disabled:opacity-50 disabled:cursor-not-allowed"
                title={
                  !isEnabled
                    ? 'LIVE_MODE=false in .env'
                    : isRunning
                      ? 'Stop the running session first'
                      : ''
                }
              >
                <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
                <span className="font-mono uppercase tracking-[0.16em]">New session</span>
                <span className="absolute inset-0 -z-10 bg-gradient-to-r from-signal to-signal opacity-0 transition group-hover:opacity-100" />
              </button>
              {isRunning && (
                <Link
                  href={`/lives/${sessions.data?.sessions.find((s) => s.status === 'RUNNING')?.id ?? ''}`}
                  className="inline-flex items-center gap-2 rounded-md border border-signal/30 bg-signal/5 px-3.5 py-2 text-[12px] text-foreground transition hover:bg-signal/10"
                >
                  <Play className="h-3 w-3 text-signal" strokeWidth={2} />
                  <span className="font-mono uppercase tracking-[0.16em]">Open active</span>
                </Link>
              )}
            </div>
          </div>

          {/* Live snapshot card — fills the height with rich content */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.15, ease: [0.16, 1, 0.3, 1] }}
            className="lg:col-span-7"
          >
            <SnapshotCard
              isRunning={isRunning}
              equity={equity}
              totalRealized={totalRealized}
              winRate={winRate}
              totalWins={totalWins}
              totalLosses={totalLosses}
              totalTrades={totalTrades}
              activeSession={allSessions.find((s) => s.status === 'RUNNING') ?? null}
              recentSessions={closedSessions.slice(0, 3)}
              margin={status.data?.account?.margin ?? null}
              balance={status.data?.account?.balance ?? null}
            />
          </motion.div>
        </div>
      </Reveal>

      <Hairline />

      {/* ─── Equity arc (only render if data) ─── */}
      <Reveal as="section" delay={0.08}>
        <SectionHeader
          eyebrow="Section · 02 / Equity arc"
          title="Account-wide trajectory"
          subtitle="Last 7 days · 1-min snapshots across every session"
        />
        <div className="mt-4 rounded-md border border-border bg-card p-4 sm:p-5">
          <EquityCurve points={equityHistory.data?.points ?? []} height={180} />
        </div>
      </Reveal>

      <Hairline />

      {/* ─── Sessions ─── */}
      <Reveal as="section" delay={0.15}>
        <SectionHeader
          eyebrow="Section · 03 / Sessions"
          title="History"
          subtitle={`${totalSessions} total · click any row to drill in`}
        />

        {allSessions.length === 0 ? (
          <EmptyState onClick={() => setDialogOpen(true)} disabled={!isEnabled || isRunning} />
        ) : (
          <>
            {/* Desktop table */}
            <div className="mt-4 hidden overflow-hidden rounded-md border border-border bg-card md:block">
              <table className="w-full text-left font-mono text-[12px]">
                <thead className="bg-muted/30 text-muted-foreground">
                  <tr>
                    <Th>Status</Th>
                    <Th>Started</Th>
                    <Th>Duration</Th>
                    <Th>Mode</Th>
                    <Th align="right">Risk</Th>
                    <Th align="right">Trades</Th>
                    <Th align="right">Win %</Th>
                    <Th align="right">Equity Δ</Th>
                    <Th align="right">P&amp;L</Th>
                    <Th> </Th>
                  </tr>
                </thead>
                <tbody>
                  {allSessions.map((s, i) => (
                    <DesktopSessionRow key={s.id} session={s} index={i} />
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <StaggerGroup className="mt-4 flex flex-col gap-2 md:hidden">
              {allSessions.map((s) => (
                <StaggerItem key={s.id}>
                  <MobileSessionCard session={s} />
                </StaggerItem>
              ))}
            </StaggerGroup>
          </>
        )}
      </Reveal>

      <StartLiveDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        defaultMode={status.data?.mt5Mode ?? 'mock'}
        metaApiAvailable={true}
        currentMockBalance={status.data?.account?.balance ?? null}
        onConfirm={async (cfg) => {
          await startMut.mutateAsync(cfg);
        }}
      />
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────── */

function SectionHeader({
  eyebrow,
  title,
  subtitle,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="space-y-1.5">
      <span className="label-eyebrow">{eyebrow}</span>
      <h2 className="display-serif text-[28px] leading-tight tracking-tight sm:text-[32px]">
        {title}
      </h2>
      {subtitle && (
        <p className="font-mono text-[11px] tracking-wide text-muted-foreground">
          {subtitle}
        </p>
      )}
    </div>
  );
}

function Hairline() {
  return <div className="hairline" />;
}

function SnapshotCard({
  isRunning,
  equity,
  totalRealized,
  winRate,
  totalWins,
  totalLosses,
  totalTrades,
  activeSession,
  recentSessions,
  margin,
  balance,
}: {
  isRunning: boolean;
  equity: number | null;
  totalRealized: number;
  winRate: number;
  totalWins: number;
  totalLosses: number;
  totalTrades: number;
  activeSession: LiveSession | null;
  recentSessions: LiveSession[];
  margin: number | null;
  balance: number | null;
}) {
  const realizedTone =
    totalRealized > 0 ? 'text-profit' : totalRealized < 0 ? 'text-loss' : 'text-foreground';

  return (
    <div className="relative h-full overflow-hidden rounded-md border border-border bg-card">
      {/* Atmospheric backdrop */}
      <div className="pointer-events-none absolute inset-0 grid-pattern opacity-20" />
      <div
        className={cn(
          'pointer-events-none absolute inset-x-0 top-0 h-px',
          isRunning
            ? 'bg-gradient-to-r from-transparent via-signal to-transparent'
            : 'bg-gradient-to-r from-transparent via-border to-transparent',
        )}
      />

      <div className="relative flex h-full flex-col">
        {/* Header */}
        <header className="flex items-center justify-between border-b border-border px-5 py-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-3 w-3 text-signal" strokeWidth={1.75} />
            <span className="label-eyebrow">Live snapshot</span>
          </div>
          <span
            className={cn(
              'font-mono text-[10px] uppercase tracking-[0.18em]',
              isRunning ? 'text-signal' : 'text-muted-foreground',
            )}
          >
            <span className={cn('mr-1', isRunning && 'animate-pulse')}>{isRunning ? '●' : '○'}</span>
            {isRunning ? 'Engine running' : 'Engine idle'}
          </span>
        </header>

        {/* Big equity */}
        <div className="px-5 pt-5 pb-2">
          <div className="label-eyebrow text-[9px]">Account equity</div>
          <div className="mt-1.5 display-num text-[44px] leading-none tracking-tight sm:text-[52px]">
            {equity !== null ? <CountUp value={equity} prefix="$" decimals={2} /> : '—'}
          </div>
          <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 font-mono text-[11px]">
            <span className="text-muted-foreground">
              Balance{' '}
              <span className="tabular-nums text-foreground">
                ${balance !== null ? balance.toFixed(2) : '—'}
              </span>
            </span>
            <span className={cn('tabular-nums', realizedTone)}>
              Realized {totalRealized >= 0 ? '+' : '−'}${Math.abs(totalRealized).toFixed(2)}
            </span>
            <span className="text-muted-foreground">
              Margin{' '}
              <span className="tabular-nums text-foreground">
                ${margin !== null ? margin.toFixed(2) : '—'}
              </span>
            </span>
          </div>
        </div>

        {/* Triple metric row */}
        <div className="grid grid-cols-3 gap-px border-y border-border bg-border">
          <SnapStatCell
            label="Win rate"
            value={totalWins + totalLosses > 0 ? `${winRate.toFixed(1)}%` : '—'}
            sub={`${totalWins}W · ${totalLosses}L`}
          />
          <SnapStatCell label="Total trades" value={String(totalTrades)} sub="closed live" />
          <SnapStatCell
            label="Sessions"
            value={String(recentSessions.length + (activeSession ? 1 : 0))}
            sub={activeSession ? '1 running' : 'none active'}
            tone={activeSession ? 'signal' : 'neutral'}
          />
        </div>

        {/* Bottom: active session OR recent strip */}
        <div className="flex-1 px-5 py-4">
          {activeSession ? (
            <div className="flex items-start gap-3">
              <span className="mt-1.5 inline-block h-1.5 w-1.5 rounded-full bg-signal animate-pulse" />
              <div className="min-w-0 flex-1">
                <div className="label-eyebrow text-[9px]">Active session</div>
                <div className="mt-0.5 font-mono text-[12px]">
                  {activeSession.id.slice(0, 8)} · {activeSession.mode.toUpperCase()}
                </div>
                <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                  Started {new Date(activeSession.startedAt).toLocaleTimeString()} ·{' '}
                  {activeSession.tradesCount} trade{activeSession.tradesCount === 1 ? '' : 's'}
                </div>
              </div>
              <Link
                href={`/lives/${activeSession.id}`}
                className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-signal/30 bg-signal/10 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-signal transition hover:bg-signal/15"
              >
                <Zap className="h-3 w-3" />
                Open
              </Link>
            </div>
          ) : recentSessions.length > 0 ? (
            <div>
              <div className="label-eyebrow text-[9px] mb-2">Last 3 sessions</div>
              <div className="grid grid-cols-3 gap-2">
                {recentSessions.map((s) => {
                  const tone =
                    s.realizedPnl > 0
                      ? 'border-profit/30 bg-profit/5 text-profit'
                      : s.realizedPnl < 0
                        ? 'border-loss/30 bg-loss/5 text-loss'
                        : 'border-border bg-card text-muted-foreground';
                  return (
                    <Link
                      key={s.id}
                      href={`/lives/${s.id}`}
                      className={cn(
                        'group rounded-md border px-2.5 py-2 transition hover:border-foreground/30',
                        tone,
                      )}
                    >
                      <div className="font-mono text-[9px] uppercase tracking-[0.14em] opacity-70">
                        {s.id.slice(0, 6)}
                      </div>
                      <div className="mt-1 font-mono text-[12px] tabular-nums">
                        {s.realizedPnl >= 0 ? '+' : '−'}${Math.abs(s.realizedPnl).toFixed(2)}
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <TrendingUpIcon className="h-3 w-3" />
              <span>Tap "New session" to begin your first run.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SnapStatCell({
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
          ? 'text-signal'
          : 'text-foreground';
  return (
    <div className="bg-card px-4 py-3 sm:px-5">
      <div className="label-eyebrow text-[9px]">{label}</div>
      <div className={cn('mt-1.5 font-mono text-[18px] tabular-nums tracking-tight sm:text-[20px]', colorClass)}>
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

function EmptyState({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <div className="relative mt-4 overflow-hidden rounded-md border border-border bg-card">
      <div className="absolute inset-0 grid-pattern opacity-30" />
      <div className="relative flex flex-col items-center justify-center px-6 py-16 text-center">
        <div className="display-serif text-[36px] italic leading-none tracking-tight text-muted-foreground">
          —
        </div>
        <p className="mt-4 max-w-sm text-[14px] text-muted-foreground">
          No sessions yet. Click{' '}
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
            New session
          </span>{' '}
          to start your first live engine cycle.
        </p>
        <button
          onClick={onClick}
          disabled={disabled}
          className="mt-6 inline-flex items-center gap-2 rounded-md bg-signal px-4 py-2 text-[12px] text-signal-foreground transition disabled:opacity-50"
        >
          <Plus className="h-3 w-3" strokeWidth={2.5} />
          <span className="font-mono uppercase tracking-[0.16em]">Begin</span>
        </button>
      </div>
    </div>
  );
}

/* ─── Desktop table row ─── */
function DesktopSessionRow({ session: s, index = 0 }: { session: LiveSession; index?: number }) {
  const { duration, winRate, pnlTone, equityDelta, equityTone, closed } = useSessionDerived(s);

  return (
    <motion.tr
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.18 + index * 0.025, duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        'group cursor-pointer border-b border-border/60 transition hover:bg-muted/30 last:border-b-0',
        s.status === 'RUNNING' && 'bg-signal/[0.02]',
      )}
    >
      <td className="px-4 py-3">
        <Link href={`/lives/${s.id}`} className="block">
          <StatusBadge status={s.status} />
        </Link>
      </td>
      <td className="px-4 py-3">
        <Link href={`/lives/${s.id}`} className="block">
          <div className="text-[12px]">{new Date(s.startedAt).toLocaleString()}</div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            {s.id.slice(0, 8)} · {s.strategyVersion}
          </div>
        </Link>
      </td>
      <td className="px-4 py-3 tabular-nums">
        <Link href={`/lives/${s.id}`} className="block">
          {formatDuration(duration)}
        </Link>
      </td>
      <td className="px-4 py-3 uppercase">
        <Link href={`/lives/${s.id}`} className="block">
          {s.mode}
        </Link>
      </td>
      <td className="px-4 py-3 text-right tabular-nums">
        <Link href={`/lives/${s.id}`} className="block">
          {s.riskPercent}%
        </Link>
      </td>
      <td className="px-4 py-3 text-right tabular-nums">
        <Link href={`/lives/${s.id}`} className="block">
          {s.tradesCount}
          <span className="ml-1.5 text-[10px] text-muted-foreground">
            {s.winsCount}W·{s.lossesCount}L
          </span>
        </Link>
      </td>
      <td className="px-4 py-3 text-right tabular-nums">
        <Link href={`/lives/${s.id}`} className="block">
          {closed > 0 ? `${winRate.toFixed(0)}%` : '—'}
        </Link>
      </td>
      <td className={cn('px-4 py-3 text-right tabular-nums', equityTone)}>
        <Link href={`/lives/${s.id}`} className="block">
          {equityDelta !== null
            ? `${equityDelta >= 0 ? '+' : ''}$${equityDelta.toFixed(2)}`
            : '—'}
        </Link>
      </td>
      <td className={cn('px-4 py-3 text-right font-medium tabular-nums', pnlTone)}>
        <Link href={`/lives/${s.id}`} className="block">
          {s.realizedPnl >= 0 ? '+' : ''}${s.realizedPnl.toFixed(2)}
        </Link>
      </td>
      <td className="px-3 py-3">
        <Link href={`/lives/${s.id}`} className="block">
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-foreground" />
        </Link>
      </td>
    </motion.tr>
  );
}

/* ─── Mobile card ─── */
function MobileSessionCard({ session: s }: { session: LiveSession }) {
  const { duration, winRate, pnlTone, closed } = useSessionDerived(s);

  return (
    <Link
      href={`/lives/${s.id}`}
      className={cn(
        'group block rounded-md border bg-card p-4 transition active:scale-[0.99]',
        s.status === 'RUNNING'
          ? 'border-signal/30 bg-signal/[0.04]'
          : 'border-border hover:border-border-strong',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <StatusBadge status={s.status} />
          <div className="mt-1.5 font-mono text-[11px] text-foreground">
            {new Date(s.startedAt).toLocaleString()}
          </div>
          <div className="font-mono text-[10px] text-muted-foreground">
            {s.id.slice(0, 8)} · {s.strategyVersion} · {s.mode.toUpperCase()}
          </div>
        </div>
        <div className="text-right">
          <div
            className={cn(
              'display-num text-[24px] leading-none tracking-tight',
              pnlTone,
            )}
          >
            {s.realizedPnl >= 0 ? '+' : '−'}${Math.abs(s.realizedPnl).toFixed(2)}
          </div>
          <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            P&amp;L
          </div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3 border-t border-border/50 pt-3">
        <CardStat label="Duration" value={formatDuration(duration)} />
        <CardStat label="Risk" value={`${s.riskPercent}%`} />
        <CardStat
          label="Win rate"
          value={closed > 0 ? `${winRate.toFixed(0)}% · ${s.tradesCount} trd` : `${s.tradesCount} trd`}
        />
      </div>
    </Link>
  );
}

function CardStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 font-mono text-[12px] tabular-nums">{value}</div>
    </div>
  );
}

/* ─── Helpers ─── */
function useSessionDerived(s: LiveSession) {
  const endTime = s.endedAt ? new Date(s.endedAt).getTime() : Date.now();
  const duration = endTime - new Date(s.startedAt).getTime();
  const closed = s.winsCount + s.lossesCount;
  const winRate = closed > 0 ? (s.winsCount / closed) * 100 : 0;
  const pnlTone =
    s.realizedPnl > 0 ? 'text-profit' : s.realizedPnl < 0 ? 'text-loss' : 'text-muted-foreground';
  const equityDelta = s.endEquity !== null ? s.endEquity - s.startEquity : null;
  const equityTone =
    equityDelta !== null && equityDelta > 0
      ? 'text-profit'
      : equityDelta !== null && equityDelta < 0
        ? 'text-loss'
        : '';
  return { duration, winRate, pnlTone, equityDelta, equityTone, closed };
}

function StatusBadge({ status }: { status: 'RUNNING' | 'ENDED' | 'CRASHED' }) {
  if (status === 'RUNNING') {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-signal opacity-75" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-signal" />
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-signal">
          Live
        </span>
      </span>
    );
  }
  if (status === 'CRASHED') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded bg-warning/15 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-warning">
        Crashed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
      Ended
    </span>
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
        'px-4 py-2.5 font-mono text-[10px] font-normal uppercase tracking-[0.16em]',
        align === 'right' && 'text-right',
      )}
    >
      {children}
    </th>
  );
}

