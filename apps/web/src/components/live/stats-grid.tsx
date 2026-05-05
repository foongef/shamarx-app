'use client';

import { LiveStats } from '@/lib/api-client';
import { cn } from '@/lib/utils';

export function StatsGrid({ stats }: { stats: LiveStats | undefined }) {
  if (!stats) {
    return (
      <div className="rounded-md border border-border p-6 text-center text-sm text-muted-foreground">
        No stats yet — start the engine and let trades close
      </div>
    );
  }

  const tone = (n: number) =>
    n > 0 ? 'text-green-400' : n < 0 ? 'text-red-400' : 'text-foreground';

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border md:grid-cols-4 lg:grid-cols-8">
        <Cell label="Trades" value={String(stats.closedTrades)} sub={`${stats.openTrades} open`} />
        <Cell
          label="Win rate"
          value={`${stats.winRate.toFixed(1)}%`}
          sub={`${stats.wins}/${stats.closedTrades}`}
        />
        <Cell label="Profit factor" value={stats.profitFactor.toFixed(2)} mono />
        <Cell label="Avg R" value={stats.avgRR.toFixed(2)} mono />
        <Cell
          label="Realized P&L"
          value={`${stats.realizedPnl >= 0 ? '+' : ''}$${stats.realizedPnl.toFixed(2)}`}
          mono
          tone={tone(stats.realizedPnl)}
        />
        <Cell
          label="Avg win"
          value={`$${stats.avgWin.toFixed(2)}`}
          mono
          tone="text-green-400"
        />
        <Cell
          label="Avg loss"
          value={`$${stats.avgLoss.toFixed(2)}`}
          mono
          tone="text-red-400"
        />
        <Cell
          label="Largest win/loss"
          value={`+$${stats.largestWin.toFixed(0)} / $${stats.largestLoss.toFixed(0)}`}
          mono
        />
      </div>

      {Object.keys(stats.perPair).length > 0 && (
        <div className="rounded-md border border-border">
          <div className="border-b border-border px-4 py-2 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
            Per-pair breakdown
          </div>
          <table className="w-full font-mono text-[12px]">
            <thead className="text-muted-foreground">
              <tr>
                <Th>Symbol</Th>
                <Th align="right">Trades</Th>
                <Th align="right">Win %</Th>
                <Th align="right">Avg P&L</Th>
                <Th align="right">Total P&L</Th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(stats.perPair).map(([pair, p]) => (
                <tr key={pair} className="border-t border-border/40">
                  <Td>{pair}</Td>
                  <Td align="right">{p.trades}</Td>
                  <Td align="right">{p.winRate.toFixed(1)}%</Td>
                  <Td align="right" className={tone(p.avgPnl)}>
                    {p.avgPnl >= 0 ? '+' : ''}${p.avgPnl.toFixed(2)}
                  </Td>
                  <Td align="right" className={cn('font-medium', tone(p.totalPnl))}>
                    {p.totalPnl >= 0 ? '+' : ''}${p.totalPnl.toFixed(2)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {Object.keys(stats.exitReasons).length > 0 && (
        <div className="flex flex-wrap gap-2">
          {Object.entries(stats.exitReasons).map(([reason, count]) => (
            <div
              key={reason}
              className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5"
            >
              <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                {reason}
              </span>
              <span className="font-mono text-[12px] tabular-nums">{count}</span>
            </div>
          ))}
        </div>
      )}
    </div>
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
    <div className="bg-background px-4 py-3">
      <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className={cn('mt-0.5 text-sm', mono && 'font-mono', tone)}>{value}</div>
      {sub && <div className="font-mono text-[10px] text-subtle">{sub}</div>}
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
        'px-4 py-2 font-normal text-[10px] uppercase tracking-widest',
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
      className={cn('px-4 py-2 tabular-nums', align === 'right' && 'text-right', className)}
    >
      {children}
    </td>
  );
}
