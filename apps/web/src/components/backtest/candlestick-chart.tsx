'use client';

import { useEffect, useRef } from 'react';
import {
  createChart,
  createSeriesMarkers,
  CandlestickSeries,
  type IChartApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { BacktestTrade, BacktestCandle } from '@/lib/types';

interface CandlestickChartProps {
  candles: BacktestCandle[];
  trades: BacktestTrade[];
  symbol?: string;
}

export function CandlestickChart({ candles, trades, symbol = 'XAUUSD' }: CandlestickChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!containerRef.current || candles.length === 0) return;

    const chart = createChart(containerRef.current, {
      height: 500,
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
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: {
        mode: 0,
      },
    });

    const toUTC = (iso: string) =>
      Math.floor(new Date(iso).getTime() / 1000) as UTCTimestamp;

    // Candlestick series with OHLC data
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderUpColor: '#22c55e',
      borderDownColor: '#ef4444',
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444',
    });

    const sortedCandles = [...candles].sort(
      (a, b) => new Date(a.openTime).getTime() - new Date(b.openTime).getTime(),
    );

    candleSeries.setData(
      sortedCandles.map((c) => ({
        time: toUTC(c.openTime),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );

    // Trade markers overlaid on the candlestick series
    if (trades.length > 0) {
      const markers = trades.flatMap((t) => [
        {
          time: toUTC(t.entryTime),
          position: (t.side === 'BUY' ? 'belowBar' : 'aboveBar') as 'belowBar' | 'aboveBar',
          color: t.side === 'BUY' ? '#22c55e' : '#ef4444',
          shape: (t.side === 'BUY' ? 'arrowUp' : 'arrowDown') as 'arrowUp' | 'arrowDown',
          text: `${t.side} @ ${t.entryPrice.toFixed(1)}`,
        },
        {
          time: toUTC(t.exitTime),
          position: (t.pnl >= 0 ? 'aboveBar' : 'belowBar') as 'aboveBar' | 'belowBar',
          color: t.pnl >= 0 ? '#22c55e' : '#ef4444',
          shape: (t.pnl >= 0 ? 'circle' : 'circle') as 'circle',
          text: `${t.exitReason} ${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(0)}`,
        },
      ]);

      markers.sort((a, b) => (a.time as number) - (b.time as number));
      createSeriesMarkers(candleSeries, markers);
    }

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
  }, [candles, trades]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">
          {symbol} M15 &mdash; Price Action & Trades
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div ref={containerRef} />
      </CardContent>
    </Card>
  );
}
