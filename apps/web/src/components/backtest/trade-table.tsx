'use client';

import { useState } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import type { BacktestTrade } from '@/lib/types';
import { formatCurrency } from '@/lib/utils';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { format } from 'date-fns';

type SortKey = 'entryTime' | 'pnl' | 'side' | 'exitReason';

interface TradeTableProps {
  trades: BacktestTrade[];
}

export function TradeTable({ trades }: TradeTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('entryTime');
  const [sortAsc, setSortAsc] = useState(true);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortAsc(!sortAsc);
    } else {
      setSortKey(key);
      setSortAsc(true);
    }
  }

  const sorted = [...trades].sort((a, b) => {
    let cmp = 0;
    switch (sortKey) {
      case 'entryTime':
        cmp = new Date(a.entryTime).getTime() - new Date(b.entryTime).getTime();
        break;
      case 'pnl':
        cmp = a.pnl - b.pnl;
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

  function SortIcon({ column }: { column: SortKey }) {
    if (sortKey !== column) return <ArrowUpDown className="ml-1 inline h-3 w-3" />;
    return sortAsc ? (
      <ArrowUp className="ml-1 inline h-3 w-3" />
    ) : (
      <ArrowDown className="ml-1 inline h-3 w-3" />
    );
  }

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead
              className="cursor-pointer"
              onClick={() => toggleSort('side')}
            >
              Side <SortIcon column="side" />
            </TableHead>
            <TableHead>Entry</TableHead>
            <TableHead>Exit</TableHead>
            <TableHead>Lots</TableHead>
            <TableHead>SL</TableHead>
            <TableHead>TP</TableHead>
            <TableHead
              className="cursor-pointer"
              onClick={() => toggleSort('pnl')}
            >
              PnL <SortIcon column="pnl" />
            </TableHead>
            <TableHead>Comm.</TableHead>
            <TableHead>Tags</TableHead>
            <TableHead
              className="cursor-pointer"
              onClick={() => toggleSort('entryTime')}
            >
              Entry Time <SortIcon column="entryTime" />
            </TableHead>
            <TableHead
              className="cursor-pointer"
              onClick={() => toggleSort('exitReason')}
            >
              Exit Reason <SortIcon column="exitReason" />
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((trade) => (
            <TableRow key={trade.id}>
              <TableCell>
                <Badge variant={trade.side === 'BUY' ? 'default' : 'destructive'}>
                  {trade.side}
                </Badge>
              </TableCell>
              <TableCell className="font-mono text-xs">
                {trade.entryPrice.toFixed(2)}
              </TableCell>
              <TableCell className="font-mono text-xs">
                {trade.exitPrice.toFixed(2)}
              </TableCell>
              <TableCell className="font-mono text-xs">
                {trade.lotSize.toFixed(2)}
              </TableCell>
              <TableCell className="font-mono text-xs">
                {trade.slPrice.toFixed(2)}
              </TableCell>
              <TableCell className="font-mono text-xs">
                {trade.tpPrice.toFixed(2)}
              </TableCell>
              <TableCell
                className={`font-mono text-xs font-semibold ${
                  trade.pnl >= 0 ? 'text-green-500' : 'text-red-500'
                }`}
              >
                {formatCurrency(trade.pnl)}
              </TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">
                {formatCurrency(trade.commission)}
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {trade.setupTags.map((tag) => (
                    <Badge key={tag} variant="outline" className="text-[10px]">
                      {tag}
                    </Badge>
                  ))}
                </div>
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {format(new Date(trade.entryTime), 'MMM d, HH:mm')}
              </TableCell>
              <TableCell>
                <Badge
                  variant="secondary"
                  className={trade.exitReason === 'BREAKEVEN' ? 'bg-amber-500/20 text-amber-500' : ''}
                >
                  {trade.exitReason}
                </Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
