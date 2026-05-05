'use client';

import { useEffect, useRef } from 'react';
import {
  AreaSeries,
  createChart,
  IChartApi,
  ISeriesApi,
  UTCTimestamp,
} from 'lightweight-charts';
import { EquityPoint } from '@/lib/api-client';

interface Props {
  points: EquityPoint[];
  height?: number;
}

export function EquityCurve({ points, height = 120 }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, {
      autoSize: true,
      layout: {
        background: { color: 'transparent' },
        textColor: '#a1a1aa',
        fontSize: 10,
        fontFamily: 'ui-monospace, SF Mono, monospace',
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: 'rgba(255,255,255,0.04)' },
      },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: { borderVisible: false },
      crosshair: { mode: 0 },
    });
    const series = chart.addSeries(AreaSeries, {
      lineColor: '#22c55e',
      topColor: 'rgba(34,197,94,0.30)',
      bottomColor: 'rgba(34,197,94,0.02)',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
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
    const data = points.map((p) => ({
      time: Math.floor(new Date(p.t).getTime() / 1000) as UTCTimestamp,
      value: p.equity,
    }));
    // dedupe equal timestamps (cron jitter)
    const dedup = data.filter((d, i, arr) => i === 0 || arr[i - 1].time !== d.time);
    seriesRef.current.setData(dedup);
    if (chartRef.current && dedup.length > 0) chartRef.current.timeScale().fitContent();
  }, [points]);

  return (
    <div
      ref={ref}
      className="w-full overflow-hidden rounded-md border border-border bg-background/40"
      style={{ height }}
    />
  );
}
