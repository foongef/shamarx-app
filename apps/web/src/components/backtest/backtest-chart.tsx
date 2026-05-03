'use client';

import { useEffect, useRef } from 'react';
import {
  createChart,
  createSeriesMarkers,
  CandlestickSeries,
  type IChartApi,
  type UTCTimestamp,
  LineStyle,
} from 'lightweight-charts';
import type { BacktestCandle, BacktestTrade } from '@/lib/types';
import { useTheme } from 'next-themes';

interface Props {
  candles: BacktestCandle[];
  trades: BacktestTrade[];
}

const toUTC = (iso: string) =>
  Math.floor(new Date(iso).getTime() / 1000) as UTCTimestamp;

export function BacktestChart({ candles, trades }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    if (!containerRef.current || candles.length === 0) return;

    const isDark = resolvedTheme !== 'light';
    const TXT = isDark ? 'rgba(232, 232, 234, 0.65)' : 'rgba(40, 40, 50, 0.7)';
    const GRID = isDark ? 'rgba(255,255,255,0.045)' : 'rgba(0,0,0,0.05)';
    const BORDER = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.1)';

    const UP = '#5fd99f';
    const DOWN = '#ef7373';
    const SIGNAL = '#d4ff3a';

    const chart = createChart(containerRef.current, {
      height: 520,
      autoSize: true,
      layout: {
        background: { color: 'transparent' },
        textColor: TXT,
        fontFamily: '"Geist Mono", ui-monospace, monospace',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: GRID },
        horzLines: { color: GRID },
      },
      rightPriceScale: {
        borderColor: BORDER,
        scaleMargins: { top: 0.08, bottom: 0.06 },
      },
      timeScale: {
        borderColor: BORDER,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
      },
      crosshair: {
        mode: 0,
        vertLine: {
          color: SIGNAL,
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: SIGNAL,
        },
        horzLine: {
          color: SIGNAL,
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: SIGNAL,
        },
      },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderUpColor: UP,
      borderDownColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });

    // Sort + dedupe candles by time (lightweight-charts requires strictly ascending)
    const seenTimes = new Set<number>();
    const uniqueCandles: BacktestCandle[] = [];
    [...candles]
      .sort(
        (a, b) =>
          new Date(a.openTime).getTime() - new Date(b.openTime).getTime(),
      )
      .forEach((c) => {
        const t = toUTC(c.openTime) as number;
        if (!seenTimes.has(t)) {
          seenTimes.add(t);
          uniqueCandles.push(c);
        }
      });

    candleSeries.setData(
      uniqueCandles.map((c) => ({
        time: toUTC(c.openTime),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );

    // Trade markers — entry triangle + exit dot, color-coded by win/loss.
    // Build the array, sort by time (lightweight-charts requires ascending),
    // then attach. Wrapped in try/catch so any single bad marker can't take
    // down the whole chart.
    if (trades.length > 0) {
      type Marker = {
        time: UTCTimestamp;
        position: 'belowBar' | 'aboveBar';
        color: string;
        shape: 'arrowUp' | 'arrowDown' | 'circle';
        text: string;
      };
      const markers: Marker[] = [];
      for (const t of trades) {
        const isWin = t.pnl >= 0;
        markers.push({
          time: toUTC(t.entryTime),
          position: t.side === 'BUY' ? 'belowBar' : 'aboveBar',
          color: t.side === 'BUY' ? UP : DOWN,
          shape: t.side === 'BUY' ? 'arrowUp' : 'arrowDown',
          text: t.side,
        });
        markers.push({
          time: toUTC(t.exitTime),
          position: isWin ? 'aboveBar' : 'belowBar',
          color: isWin ? UP : DOWN,
          shape: 'circle',
          text:
            t.exitReason +
            (isWin ? ' +' : ' ') +
            `$${t.pnl.toFixed(0)}`,
        });
      }
      markers.sort((a, b) => (a.time as number) - (b.time as number));

      try {
        createSeriesMarkers(candleSeries, markers);
      } catch (e) {
        console.warn('[BacktestChart] marker render failed:', e);
      }
    }

    chart.timeScale().fitContent();
    chartRef.current = chart;

    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [candles, trades, resolvedTheme]);

  return (
    <div className="relative">
      <div className="absolute right-3 top-3 z-10 flex flex-wrap items-center gap-3 text-[10px] uppercase tracking-widest text-muted-foreground">
        <LegendItem color="bg-profit" label="Long / Win" />
        <LegendItem color="bg-loss" label="Short / Loss" />
        <span className="text-subtle">
          ▲ entry · ● exit
        </span>
      </div>
      <div ref={containerRef} className="h-[520px] w-full" />
    </div>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${color}`} />
      {label}
    </span>
  );
}
