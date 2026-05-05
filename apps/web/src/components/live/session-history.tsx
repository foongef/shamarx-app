'use client';

import { useState } from 'react';
import { ChevronDown, Activity } from 'lucide-react';
import { LiveSession, LiveTrade, api } from '@/lib/api-client';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/utils';

function formatDuration(ms: number): string {
  if (ms < 0) return '—';
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86_400);
  const hours = Math.floor((totalSec % 86_400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m`;
  return `${totalSec}s`;
}

export function SessionHistory({ sessions }: { sessions: LiveSession[] }) {
  if (sessions.length === 0) {
    return (
      <div className="flex items-center gap-2 py-10 text-center text-sm text-muted-foreground">
        <Activity className="h-4 w-4" />
        <span className="mx-auto">No sessions yet — click Start live to create one</span>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {sessions.map((s) => (
        <SessionRow key={s.id} session={s} />
      ))}
    </div>
  );
}

function SessionRow({ session: s }: { session: LiveSession }) {
  const [expanded, setExpanded] = useState(false);

  const isRunning = s.status === 'RUNNING';
  const endTime = s.endedAt ? new Date(s.endedAt).getTime() : Date.now();
  const duration = endTime - new Date(s.startedAt).getTime();
  const closed = s.winsCount + s.lossesCount;
  const winRate = closed > 0 ? (s.winsCount / closed) * 100 : 0;
  const pnlTone =
    s.realizedPnl > 0 ? 'text-green-400' : s.realizedPnl < 0 ? 'text-red-400' : 'text-muted-foreground';

  return (
    <div
      className={cn(
        'rounded-md border bg-background transition',
        isRunning ? 'border-green-500/30 bg-green-500/[0.02]' : 'border-border',
      )}
    >
      <button
        onClick={() => setExpanded((x) => !x)}
        className="grid w-full grid-cols-12 items-center gap-4 px-4 py-3 text-left hover:bg-muted/20"
      >
        {/* Status + ID */}
        <div className="col-span-3 flex items-center gap-3">
          <StatusBadge status={s.status} />
          <div className="min-w-0">
            <div className="font-mono text-[12px] text-foreground">
              {new Date(s.startedAt).toLocaleString()}
            </div>
            <div className="font-mono text-[10px] text-muted-foreground">
              {s.id.slice(0, 8)} · {s.strategyVersion}
            </div>
          </div>
        </div>

        {/* Duration */}
        <Cell label="Duration" value={formatDuration(duration)} mono />

        {/* Mode */}
        <Cell label="Mode" value={s.mode.toUpperCase()} mono />

        {/* Risk */}
        <Cell label="Risk" value={`${s.riskPercent}%`} mono />

        {/* Trades */}
        <Cell label="Trades" value={`${s.tradesCount}`} sub={`${s.winsCount}W ${s.lossesCount}L`} mono />

        {/* Win rate */}
        <Cell label="Win %" value={closed > 0 ? `${winRate.toFixed(0)}%` : '—'} mono />

        {/* P&L */}
        <Cell
          label="P&L"
          value={`${s.realizedPnl >= 0 ? '+' : ''}$${s.realizedPnl.toFixed(2)}`}
          mono
          tone={pnlTone}
        />

        {/* Equity Δ */}
        <Cell
          label="Equity Δ"
          value={
            s.endEquity !== null
              ? `$${s.startEquity.toFixed(0)} → $${s.endEquity.toFixed(0)}`
              : `$${s.startEquity.toFixed(0)} → ?`
          }
          mono
        />

        <ChevronDown
          className={cn(
            'col-span-1 ml-auto h-4 w-4 text-muted-foreground transition-transform',
            expanded && 'rotate-180',
          )}
        />
      </button>

      {expanded && <SessionDetails sessionId={s.id} />}
    </div>
  );
}

function SessionDetails({ sessionId }: { sessionId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['session-trades', sessionId],
    queryFn: () => api.liveSessionTrades(sessionId),
  });
  const trades = data?.trades ?? [];

  if (isLoading) {
    return <div className="border-t border-border px-4 py-3 text-sm text-muted-foreground">Loading…</div>;
  }
  if (trades.length === 0) {
    return (
      <div className="border-t border-border px-4 py-3 text-sm text-muted-foreground">
        No trades fired during this session
      </div>
    );
  }
  return (
    <div className="overflow-x-auto border-t border-border">
      <table className="w-full font-mono text-[11px]">
        <thead className="bg-muted/20 text-muted-foreground">
          <tr>
            <Th>Opened</Th>
            <Th>Symbol</Th>
            <Th>Side</Th>
            <Th align="right">Lot</Th>
            <Th align="right">Entry</Th>
            <Th align="right">Exit</Th>
            <Th>Status</Th>
            <Th align="right">P&amp;L</Th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t: LiveTrade) => (
            <tr key={t.id} className="border-t border-border/30">
              <Td>{new Date(t.createdAt).toLocaleTimeString()}</Td>
              <Td>{t.symbol}</Td>
              <Td className={t.side === 'BUY' ? 'text-green-400' : 'text-red-400'}>{t.side}</Td>
              <Td align="right">{t.lotSize.toFixed(2)}</Td>
              <Td align="right">{t.entryPrice.toFixed(5)}</Td>
              <Td align="right">{t.closePrice ? t.closePrice.toFixed(5) : '—'}</Td>
              <Td>
                <span className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
                  {t.status}
                  {t.exitReason && ` · ${t.exitReason}`}
                </span>
              </Td>
              <Td
                align="right"
                className={cn(
                  t.pnl !== null && t.pnl >= 0 && 'text-green-400',
                  t.pnl !== null && t.pnl < 0 && 'text-red-400',
                )}
              >
                {t.pnl !== null ? `${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)}` : '—'}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusBadge({ status }: { status: 'RUNNING' | 'ENDED' | 'CRASHED' }) {
  if (status === 'RUNNING') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded px-1.5 py-0.5">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-red-500" />
        </span>
        <span className="font-mono text-[10px] uppercase tracking-widest text-red-400">LIVE</span>
      </span>
    );
  }
  if (status === 'CRASHED') {
    return (
      <span className="rounded bg-yellow-500/15 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest text-yellow-300">
        CRASHED
      </span>
    );
  }
  return (
    <span className="rounded bg-zinc-500/15 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest text-zinc-300">
      ENDED
    </span>
  );
}

function Cell({
  label,
  value,
  sub,
  mono,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  mono?: boolean;
  tone?: string;
}) {
  return (
    <div className="col-span-1">
      <div className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className={cn('text-[12px] tabular-nums', mono && 'font-mono', tone)}>{value}</div>
      {sub && <div className="font-mono text-[9px] text-subtle">{sub}</div>}
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
        'px-3 py-2 font-normal text-[9px] uppercase tracking-widest',
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
      className={cn('px-3 py-1.5 tabular-nums', align === 'right' && 'text-right', className)}
    >
      {children}
    </td>
  );
}
