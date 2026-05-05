'use client';

import { LivePosition } from '@/lib/api-client';
import { cn } from '@/lib/utils';

export function EquityTile({
  balance,
  equity,
  openPositions,
  mode,
  running,
  startEquity,
}: {
  balance: number | null;
  equity: number | null;
  openPositions: LivePosition[];
  mode: string;
  running: boolean;
  /** When provided, shows P&L delta vs this baseline (e.g. session start). */
  startEquity?: number | null;
}) {
  const unrealized = openPositions.reduce((s, p) => s + (p.pnl ?? 0), 0);
  const tone = unrealized > 0 ? 'text-profit' : unrealized < 0 ? 'text-loss' : 'text-muted-foreground';

  const sessionDelta = equity !== null && startEquity ? equity - startEquity : null;
  const sessionDeltaTone =
    sessionDelta !== null && sessionDelta > 0
      ? 'text-profit'
      : sessionDelta !== null && sessionDelta < 0
        ? 'text-loss'
        : 'text-muted-foreground';

  return (
    <div className="relative overflow-hidden rounded-md border border-border bg-card">
      {/* Subtle grid backdrop */}
      <div className="absolute inset-0 grid-pattern opacity-30" />

      <div className="relative p-5">
        <div className="flex items-baseline justify-between">
          <span className="label-eyebrow">Account · {mode.toUpperCase()}</span>
          <span
            className={cn(
              'font-mono text-[10px] uppercase tracking-[0.18em]',
              running ? 'text-signal' : 'text-muted-foreground',
            )}
          >
            {running ? '● Live' : 'Paused'}
          </span>
        </div>

        <div className="mt-4 space-y-1.5">
          <div className="display-num text-[44px] tracking-tight">
            {equity !== null ? `$${equity.toFixed(2)}` : '—'}
          </div>
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[12px]">
            <span className="font-mono text-muted-foreground">
              Balance{' '}
              <span className="tabular-nums text-foreground">
                ${balance !== null ? balance.toFixed(2) : '—'}
              </span>
            </span>
            <span className={cn('font-mono tabular-nums', tone)}>
              {openPositions.length > 0
                ? `${unrealized >= 0 ? '+' : ''}$${unrealized.toFixed(2)} unrealized`
                : 'No open positions'}
            </span>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3 border-t border-border/60 pt-3">
          <div>
            <div className="label-eyebrow text-[9px]">Open positions</div>
            <div className="mt-0.5 font-mono text-[14px] tabular-nums">
              {openPositions.length}
            </div>
          </div>
          <div>
            <div className="label-eyebrow text-[9px]">
              {sessionDelta !== null ? 'Session Δ' : 'Drawdown from peak'}
            </div>
            <div className={cn('mt-0.5 font-mono text-[14px] tabular-nums', sessionDeltaTone)}>
              {sessionDelta !== null
                ? `${sessionDelta >= 0 ? '+' : ''}$${sessionDelta.toFixed(2)}`
                : '—'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
