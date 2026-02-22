'use client';

import { useEffect, useRef } from 'react';
import { createChart, createSeriesMarkers, LineSeries, type IChartApi } from 'lightweight-charts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { BacktestTrade } from '@/lib/types';

interface CandlestickChartProps {
  trades: BacktestTrade[];
}

export function CandlestickChart({ trades }: CandlestickChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!containerRef.current || trades.length === 0) return;

    const chart = createChart(containerRef.current, {
      height: 400,
      layout: {
        background: { color: 'transparent' },
        textColor: '#9ca3af',
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.05)' },
        horzLines: { color: 'rgba(255,255,255,0.05)' },
      },
      rightPriceScale: {
        borderColor: 'rgba(255,255,255,0.1)',
      },
      timeScale: {
        borderColor: 'rgba(255,255,255,0.1)',
      },
    });

    const sorted = [...trades].sort(
      (a, b) => new Date(a.entryTime).getTime() - new Date(b.entryTime).getTime(),
    );

    // Entry price line
    const entryData = sorted.map((t) => ({
      time: t.entryTime.split('T')[0],
      value: t.entryPrice,
    }));
    const entrySeries = chart.addSeries(LineSeries, {
      color: '#6366f1',
      lineWidth: 2,
      title: 'Entry Price',
    });
    entrySeries.setData(entryData);

    // Trade markers
    const markers = sorted.flatMap((t) => [
      {
        time: t.entryTime.split('T')[0],
        position: 'belowBar' as const,
        color: t.side === 'BUY' ? '#22c55e' : '#ef4444',
        shape: 'arrowUp' as const,
        text: `${t.side} @ ${t.entryPrice.toFixed(1)}`,
      },
      {
        time: t.exitTime.split('T')[0],
        position: 'aboveBar' as const,
        color: t.pnl >= 0 ? '#22c55e' : '#ef4444',
        shape: 'arrowDown' as const,
        text: `Exit ${t.exitReason} (${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)})`,
      },
    ]);

    // Sort markers by time for lightweight-charts
    markers.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
    createSeriesMarkers(entrySeries, markers);

    chart.timeScale().fitContent();
    chartRef.current = chart;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        chart.applyOptions({ width: entry.contentRect.width });
      }
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [trades]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">
          Trade Entries & Exits
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div ref={containerRef} />
      </CardContent>
    </Card>
  );
}
