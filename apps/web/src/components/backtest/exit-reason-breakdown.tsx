'use client';

import { exitReasonBreakdown } from '@/lib/trade-stats';
import type { BacktestTrade } from '@/lib/types';
import { ExitReasonBadge } from './exit-reason-badge';
import { formatSignedMoney } from './value';
import { cn } from '@/lib/utils';

export function ExitReasonBreakdown({ trades }: { trades: BacktestTrade[] }) {
  const data = exitReasonBreakdown(trades).sort((a, b) => b.count - a.count);
  const total = trades.length;

  if (data.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center font-mono text-[11px] text-subtle">
        No closed trades.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Stacked bar */}
      <div className="flex h-2 w-full overflow-hidden border border-border">
        {data.map((d) => {
          const tone =
            d.reason === 'TP'
              ? 'bg-profit'
              : d.reason === 'SL'
              ? 'bg-loss'
              : d.reason === 'BREAKEVEN'
              ? 'bg-muted-foreground'
              : 'bg-warning';
          return (
            <div
              key={d.reason}
              className={cn('transition-all', tone)}
              style={{ width: `${d.ratio * 100}%` }}
            />
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-1.5">
        {data.map((d) => (
          <div
            key={d.reason}
            className="flex items-center justify-between gap-3 border border-border px-3 py-1.5 text-[12px]"
          >
            <div className="flex items-center gap-2">
              <ExitReasonBadge reason={d.reason} />
              <span className="font-mono text-[11px] text-muted-foreground">
                {(d.ratio * 100).toFixed(1)}%
              </span>
            </div>
            <div className="flex items-center gap-4">
              <span className="font-mono tnum text-muted-foreground">
                {d.count}/{total}
              </span>
              <span
                className={cn(
                  'font-mono tnum',
                  d.pnl >= 0 ? 'text-profit' : 'text-loss',
                )}
              >
                {formatSignedMoney(d.pnl, 0)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
