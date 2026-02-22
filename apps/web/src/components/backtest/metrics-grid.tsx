'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { BacktestMetrics } from '@/lib/types';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/utils';

interface MetricsGridProps {
  metrics: BacktestMetrics;
  initialBalance: number;
}

export function MetricsGrid({ metrics, initialBalance }: MetricsGridProps) {
  const items = [
    { label: 'Total Trades', value: metrics.totalTrades.toString() },
    {
      label: 'Win Rate',
      value: formatPercent(metrics.winRate * 100).replace('+', ''),
      color: metrics.winRate >= 0.5 ? 'text-green-500' : 'text-red-500',
    },
    {
      label: 'Profit Factor',
      value: formatNumber(metrics.profitFactor),
      color: metrics.profitFactor >= 1 ? 'text-green-500' : 'text-red-500',
    },
    {
      label: 'Sharpe Ratio',
      value: formatNumber(metrics.sharpeRatio),
      color: metrics.sharpeRatio >= 1 ? 'text-green-500' : 'text-red-500',
    },
    {
      label: 'Total PnL',
      value: formatCurrency(metrics.totalPnl),
      color: metrics.totalPnl >= 0 ? 'text-green-500' : 'text-red-500',
    },
    {
      label: 'Return',
      value: formatPercent(metrics.returnPercent),
      color: metrics.returnPercent >= 0 ? 'text-green-500' : 'text-red-500',
    },
    {
      label: 'Max Drawdown',
      value: `${formatNumber(metrics.maxDrawdownPercent)}%`,
      color: 'text-red-500',
    },
    {
      label: 'Final Balance',
      value: formatCurrency(metrics.finalBalance),
    },
    {
      label: 'Avg Win',
      value: formatCurrency(metrics.avgWin),
      color: 'text-green-500',
    },
    {
      label: 'Avg Loss',
      value: formatCurrency(metrics.avgLoss),
      color: 'text-red-500',
    },
    {
      label: 'Avg R:R',
      value: formatNumber(metrics.avgRR),
    },
    {
      label: 'Largest Win',
      value: formatCurrency(metrics.largestWin),
      color: 'text-green-500',
    },
    {
      label: 'Largest Loss',
      value: formatCurrency(metrics.largestLoss),
      color: 'text-red-500',
    },
    {
      label: 'Max Consec. Wins',
      value: metrics.maxConsecutiveWins.toString(),
    },
    {
      label: 'Max Consec. Losses',
      value: metrics.maxConsecutiveLosses.toString(),
    },
    {
      label: 'Initial Balance',
      value: formatCurrency(initialBalance),
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {items.map((item) => (
        <Card key={item.label}>
          <CardHeader className="pb-1 pt-3 px-4">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              {item.label}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-3">
            <p className={`text-lg font-bold ${item.color ?? ''}`}>
              {item.value}
            </p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
