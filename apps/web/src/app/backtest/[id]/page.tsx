'use client';

import { use } from 'react';
import { useBacktest } from '@/hooks/use-backtest';
import { useBacktestTrades } from '@/hooks/use-backtest-trades';
import { useBacktestCandles } from '@/hooks/use-backtest-candles';
import { MetricsGrid } from '@/components/backtest/metrics-grid';
import { EquityCurveChart } from '@/components/backtest/equity-curve-chart';
import { DrawdownChart } from '@/components/backtest/drawdown-chart';
import { CandlestickChart } from '@/components/backtest/candlestick-chart';
import { TradeTable } from '@/components/backtest/trade-table';
import { computeEquityCurve, computeDrawdownSeries } from '@/lib/chart-utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import { Loader2, AlertCircle } from 'lucide-react';

export default function BacktestResultPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { data: backtest, isLoading } = useBacktest(id);
  const isCompleted = backtest?.status === 'COMPLETED';
  const { data: trades } = useBacktestTrades(id, isCompleted);
  const { data: candles } = useBacktestCandles(id, isCompleted);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-4">
                <Skeleton className="h-6 w-24" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (!backtest) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 p-6 text-destructive">
          <AlertCircle className="h-5 w-5" />
          Backtest not found.
        </CardContent>
      </Card>
    );
  }

  // PENDING / RUNNING
  if (backtest.status === 'PENDING' || backtest.status === 'RUNNING') {
    return (
      <div className="space-y-6">
        <Header backtest={backtest} />
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-16">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-muted-foreground">
              Running backtest... This may take a few minutes.
            </p>
            <Badge variant="secondary">{backtest.status}</Badge>
          </CardContent>
        </Card>
      </div>
    );
  }

  // FAILED
  if (backtest.status === 'FAILED') {
    return (
      <div className="space-y-6">
        <Header backtest={backtest} />
        <Card className="border-destructive">
          <CardHeader>
            <CardTitle className="text-destructive">Backtest Failed</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {backtest.errorMessage || 'An unknown error occurred.'}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // COMPLETED
  const equityCurve =
    trades && trades.length > 0
      ? computeEquityCurve(trades, backtest.initialBalance)
      : [];
  const drawdownSeries =
    trades && trades.length > 0
      ? computeDrawdownSeries(trades, backtest.initialBalance)
      : [];

  return (
    <div className="space-y-6">
      <Header backtest={backtest} />

      {backtest.metrics && (
        <MetricsGrid
          metrics={backtest.metrics}
          initialBalance={backtest.initialBalance}
        />
      )}

      <Separator />

      {equityCurve.length > 0 && <EquityCurveChart data={equityCurve} />}
      {drawdownSeries.length > 0 && <DrawdownChart data={drawdownSeries} />}

      {candles && candles.length > 0 && (
        <CandlestickChart candles={candles} trades={trades ?? []} symbol={backtest.symbol} />
      )}

      <Separator />

      {trades && trades.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">Trade History</h2>
          <TradeTable trades={trades} />
        </div>
      )}
    </div>
  );
}

function Header({
  backtest,
}: {
  backtest: { id: string; symbol: string; startDate: string; endDate: string; status: string; withLlm: boolean };
}) {
  const statusColor: Record<string, string> = {
    PENDING: 'bg-yellow-500/10 text-yellow-500',
    RUNNING: 'bg-blue-500/10 text-blue-500',
    COMPLETED: 'bg-green-500/10 text-green-500',
    FAILED: 'bg-red-500/10 text-red-500',
  };

  return (
    <div className="flex items-center justify-between">
      <div>
        <h1 className="text-2xl font-bold">{backtest.symbol} Backtest</h1>
        <p className="text-sm text-muted-foreground">
          {backtest.startDate} &mdash; {backtest.endDate}
          {backtest.withLlm && (
            <Badge variant="outline" className="ml-2">
              LLM
            </Badge>
          )}
        </p>
      </div>
      <Badge className={statusColor[backtest.status] ?? ''}>
        {backtest.status}
      </Badge>
    </div>
  );
}
