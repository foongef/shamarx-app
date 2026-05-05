'use client';

import { useEffect, useRef } from 'react';
import {
  CandlestickSeries,
  createChart,
  IChartApi,
  ISeriesApi,
  UTCTimestamp,
} from 'lightweight-charts';
import { Wifi, WifiOff } from 'lucide-react';
import { LiveCandle } from '@/lib/api-client';

export function CandleChart({
  candles,
  loading,
  error,
  /** Used to invalidate the last-known-data cache when the user switches pairs.
   *  Without this, switching from EURUSD → USDJPY mid-error would show stale
   *  EURUSD data on the USDJPY chart. */
  symbol,
  height = 420,
}: {
  candles: LiveCandle[];
  loading?: boolean;
  /** When set, shows "Connection lost — retrying" overlay; preserves last data. */
  error?: string | null;
  symbol?: string;
  height?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  // Last successful candle set — keyed by symbol so cross-pair switches don't
  // show stale data from another pair.
  const lastDataRef = useRef<{ symbol: string; data: LiveCandle[] }>({ symbol: '', data: [] });

  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, {
      autoSize: true,
      layout: {
        background: { color: 'transparent' },
        textColor: '#a1a1aa',
        fontSize: 11,
        fontFamily: 'ui-monospace, SF Mono, monospace',
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.04)' },
        horzLines: { color: 'rgba(255,255,255,0.04)' },
      },
      timeScale: { borderColor: 'rgba(255,255,255,0.08)', timeVisible: true },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)' },
      crosshair: { mode: 1 },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderUpColor: '#22c55e',
      borderDownColor: '#ef4444',
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444',
    });
    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!seriesRef.current) return;

    // Only treat the cached last-data as fallback if it belongs to the
    // CURRENT symbol. Otherwise we'd render the previous pair's prices.
    const cacheMatches = lastDataRef.current.symbol === (symbol ?? '');
    const effective =
      candles.length === 0 && error && cacheMatches && lastDataRef.current.data.length > 0
        ? lastDataRef.current.data
        : candles;

    const data = effective.map((c) => ({
      time: Math.floor(new Date(c.openTime).getTime() / 1000) as UTCTimestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
    seriesRef.current.setData(data);
    if (chartRef.current && data.length > 0) chartRef.current.timeScale().fitContent();
    if (effective === candles && candles.length > 0) {
      lastDataRef.current = { symbol: symbol ?? '', data: candles };
    }
  }, [candles, error, symbol]);

  // When the user switches pair tab, immediately clear the chart so we don't
  // flash the wrong pair's candles between fetches.
  useEffect(() => {
    if (!seriesRef.current) return;
    if (lastDataRef.current.symbol !== (symbol ?? '')) {
      seriesRef.current.setData([]);
    }
  }, [symbol]);

  const cacheMatches = lastDataRef.current.symbol === (symbol ?? '');
  const hasAnyData =
    candles.length > 0 || (cacheMatches && lastDataRef.current.data.length > 0);

  return (
    <div
      className="relative w-full overflow-hidden rounded-md border border-border bg-background/40"
      style={{ height }}
    >
      <div ref={ref} className="absolute inset-0" />
      {loading && !hasAnyData && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          <Wifi className="mr-2 h-4 w-4 animate-pulse" /> Loading candles…
        </div>
      )}
      {!loading && !hasAnyData && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          No candle data
        </div>
      )}
      {error && hasAnyData && (
        <div className="absolute right-2 top-2 inline-flex items-center gap-1.5 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-2.5 py-1 font-mono text-[10px] text-yellow-200 backdrop-blur">
          <WifiOff className="h-3 w-3" />
          Connection lost — showing last known
        </div>
      )}
    </div>
  );
}
