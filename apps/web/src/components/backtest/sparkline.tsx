'use client';

import { cn } from '@/lib/utils';
import { useMemo } from 'react';

export function Sparkline({
  data,
  width = 96,
  height = 24,
  className,
  positive,
  showLast = false,
}: {
  data: number[];
  width?: number;
  height?: number;
  className?: string;
  positive?: boolean;
  showLast?: boolean;
}) {
  const { path, area, last, lastY } = useMemo(() => {
    if (!data || data.length < 2) {
      return { path: '', area: '', last: 0, lastY: height };
    }
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = Math.max(1e-9, max - min);
    const stepX = width / (data.length - 1);
    const points = data.map((v, i) => {
      const x = i * stepX;
      const y = height - ((v - min) / range) * (height - 2) - 1;
      return [x, y] as const;
    });
    const path = points
      .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`)
      .join(' ');
    const area =
      `M0,${height} ` +
      points.map(([x, y]) => `L${x.toFixed(2)},${y.toFixed(2)}`).join(' ') +
      ` L${width},${height} Z`;
    return {
      path,
      area,
      last: data[data.length - 1],
      lastY: points[points.length - 1][1],
    };
  }, [data, width, height]);

  const tone =
    typeof positive === 'boolean'
      ? positive
        ? 'text-profit'
        : 'text-loss'
      : 'text-muted-foreground';

  if (!path) {
    return (
      <div
        className="flex h-6 w-24 items-center justify-center text-[10px] text-subtle"
        style={{ width, height }}
      >
        —
      </div>
    );
  }

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={cn(tone, className)}
    >
      <path d={area} fill="currentColor" opacity={0.12} />
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {showLast && (
        <circle
          cx={width - 1}
          cy={lastY}
          r={1.5}
          fill="currentColor"
        />
      )}
    </svg>
  );
}
