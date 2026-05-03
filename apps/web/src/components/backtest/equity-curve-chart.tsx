'use client';

import { useEffect, useRef } from 'react';
import {
  createChart,
  AreaSeries,
  type IChartApi,
  type UTCTimestamp,
  LineStyle,
} from 'lightweight-charts';
import type { EquityPoint } from '@/lib/trade-stats';
import { useTheme } from 'next-themes';

export function EquityCurveChart({
  data,
  height = 220,
}: {
  data: EquityPoint[];
  height?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    if (!containerRef.current || data.length < 2) return;
    const isDark = resolvedTheme !== 'light';
    const TXT = isDark ? 'rgba(232,232,234,0.65)' : 'rgba(40,40,50,0.7)';
    const GRID = isDark ? 'rgba(255,255,255,0.045)' : 'rgba(0,0,0,0.05)';
    const BORDER = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.1)';
    const ACCENT = '#d4ff3a';

    const chart = createChart(containerRef.current, {
      height,
      autoSize: true,
      layout: {
        background: { color: 'transparent' },
        textColor: TXT,
        fontFamily: '"Geist Mono", ui-monospace, monospace',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: GRID },
        horzLines: { color: GRID },
      },
      rightPriceScale: { borderColor: BORDER },
      timeScale: {
        borderColor: BORDER,
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: {
        mode: 0,
        vertLine: {
          style: LineStyle.Dashed,
          width: 1,
          color: ACCENT,
          labelBackgroundColor: ACCENT,
        },
        horzLine: {
          style: LineStyle.Dashed,
          width: 1,
          color: ACCENT,
          labelBackgroundColor: ACCENT,
        },
      },
    });

    const series = chart.addSeries(AreaSeries, {
      lineColor: ACCENT,
      lineWidth: 2,
      topColor: 'rgba(212,255,58,0.20)',
      bottomColor: 'rgba(212,255,58,0)',
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });

    series.setData(
      data.map((p) => ({
        time: p.time as UTCTimestamp,
        value: p.equity,
      })),
    );
    chart.timeScale().fitContent();
    chartRef.current = chart;
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [data, height, resolvedTheme]);

  return <div ref={containerRef} className="w-full" style={{ height }} />;
}
