'use client';

import { Activity } from 'lucide-react';
import { LivePosition } from '@/lib/api-client';
import { cn } from '@/lib/utils';

export function PositionsTable({ positions }: { positions: LivePosition[] }) {
  if (positions.length === 0) {
    return (
      <div className="flex items-center gap-2 py-10 text-center text-sm text-muted-foreground">
        <Activity className="h-4 w-4" />
        <span className="mx-auto">No open positions</span>
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left font-mono text-[12px]">
        <thead className="border-b border-border text-muted-foreground">
          <tr>
            <Th>Ticket</Th>
            <Th>Symbol</Th>
            <Th>Side</Th>
            <Th align="right">Lot</Th>
            <Th align="right">Entry</Th>
            <Th align="right">Current</Th>
            <Th align="right">SL</Th>
            <Th align="right">TP</Th>
            <Th align="right">P&amp;L</Th>
            <Th>Open time</Th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => (
            <tr key={p.ticket} className="border-b border-border/50 last:border-b-0">
              <Td>{p.ticket}</Td>
              <Td>{p.symbol}</Td>
              <Td>
                <span className={cn(p.side === 'BUY' ? 'text-green-400' : 'text-red-400')}>
                  {p.side}
                </span>
              </Td>
              <Td align="right">{p.lotSize.toFixed(2)}</Td>
              <Td align="right">{p.entryPrice.toFixed(5)}</Td>
              <Td align="right">{p.currentPrice.toFixed(5)}</Td>
              <Td align="right">{p.sl.toFixed(5)}</Td>
              <Td align="right">{p.tp.toFixed(5)}</Td>
              <Td align="right" className={p.pnl >= 0 ? 'text-green-400' : 'text-red-400'}>
                {p.pnl >= 0 ? '+' : ''}${p.pnl.toFixed(2)}
              </Td>
              <Td>{new Date(p.openTime).toLocaleTimeString()}</Td>
            </tr>
          ))}
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
        'px-3 py-2 font-normal text-[10px] uppercase tracking-widest',
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
