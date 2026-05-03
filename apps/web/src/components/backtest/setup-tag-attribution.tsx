'use client';

import { setupTagAttribution } from '@/lib/trade-stats';
import type { BacktestTrade } from '@/lib/types';
import { formatSignedMoney } from './value';
import { cn } from '@/lib/utils';

export function SetupTagAttribution({
  trades,
}: {
  trades: BacktestTrade[];
}) {
  const data = setupTagAttribution(trades).slice(0, 12);
  const maxCount = Math.max(1, ...data.map((d) => d.count));

  if (data.length === 0) {
    return (
      <div className="flex h-24 items-center justify-center font-mono text-[11px] text-subtle">
        No tagged setups.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-border">
            <Th>Setup Tag</Th>
            <Th align="right">Count</Th>
            <Th align="right">Win%</Th>
            <Th align="right">PnL</Th>
            <Th align="right">Frequency</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {data.map((d) => {
            const ratio = d.count / maxCount;
            return (
              <tr key={d.tag} className="row-hover">
                <Td>
                  <span className="font-mono text-[11px] uppercase tracking-wider">
                    {d.tag}
                  </span>
                </Td>
                <Td align="right">
                  <span className="text-muted-foreground tnum">{d.count}</span>
                </Td>
                <Td align="right">
                  <span
                    className={cn(
                      'tnum',
                      d.winRate >= 60
                        ? 'text-profit'
                        : d.winRate >= 45
                        ? 'text-foreground'
                        : 'text-loss',
                    )}
                  >
                    {d.winRate.toFixed(1)}%
                  </span>
                </Td>
                <Td align="right">
                  <span
                    className={cn(
                      'tnum',
                      d.pnl >= 0 ? 'text-profit' : 'text-loss',
                    )}
                  >
                    {formatSignedMoney(d.pnl, 0)}
                  </span>
                </Td>
                <Td align="right">
                  <div className="flex h-1.5 w-full items-center justify-end gap-1.5">
                    <div className="relative h-1.5 w-24 border border-border bg-surface">
                      <div
                        className="absolute inset-y-0 left-0 bg-signal/60"
                        style={{ width: `${ratio * 100}%` }}
                      />
                    </div>
                  </div>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
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
        'label-eyebrow whitespace-nowrap px-3 py-2',
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
