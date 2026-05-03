'use client';

import type { RBucket } from '@/lib/trade-stats';
import { cn } from '@/lib/utils';

export function RDistribution({ data }: { data: RBucket[] }) {
  const max = Math.max(1, ...data.map((b) => b.count));
  const total = data.reduce((s, b) => s + b.count, 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-end gap-1.5 h-[140px]">
        {data.map((b, i) => {
          const ratio = b.count / max;
          const isWin = b.range[0] >= 0;
          // height has a 4px floor so 0-count bars are still visible as dust
          const h = b.count === 0 ? 4 : Math.max(8, ratio * 130);
          return (
            <div
              key={b.label}
              className="group relative flex flex-1 flex-col items-center gap-1.5"
            >
              <div
                className="absolute -top-5 hidden font-mono text-[10px] tabular-nums text-foreground group-hover:block"
              >
                {b.count}
              </div>
              <div
                className={cn(
                  'w-full transition-all',
                  isWin
                    ? 'bg-profit/40 group-hover:bg-profit'
                    : 'bg-loss/40 group-hover:bg-loss',
                )}
                style={{ height: `${h}px` }}
              />
              <div
                className={cn(
                  'h-px w-full',
                  i === 3 ? 'bg-border-strong' : 'bg-border',
                )}
              />
            </div>
          );
        })}
      </div>
      <div className="flex gap-1.5 -mt-1.5">
        {data.map((b) => (
          <div
            key={b.label}
            className="flex flex-1 flex-col items-center"
          >
            <span className="font-mono text-[9.5px] tabular-nums text-muted-foreground">
              {b.label}
            </span>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between border-t border-border pt-2 font-mono text-[10.5px] text-subtle">
        <span>R-MULTIPLE</span>
        <span className="tnum">n = {total}</span>
      </div>
    </div>
  );
}
