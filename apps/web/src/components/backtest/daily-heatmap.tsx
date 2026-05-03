'use client';

import { useMemo } from 'react';
import type { DayCell } from '@/lib/trade-stats';
import { cn } from '@/lib/utils';

const DAY_LABELS = ['Mon', 'Wed', 'Fri']; // sparse labels to match GitHub
const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

const SQUARE = 11; // px
const GAP = 2;

/**
 * GitHub-style daily contribution heatmap, repurposed for backtest PnL.
 *
 * Rows = day-of-week (Sun→Sat, top to bottom).
 * Columns = ISO weeks across the time range.
 * Cell color encodes PnL sign (red/green) and intensity by magnitude.
 */
export function DailyHeatmap({
  data,
  startDate,
  endDate,
}: {
  data: DayCell[];
  startDate: string; // YYYY-MM-DD or ISO
  endDate: string;
}) {
  const grid = useMemo(() => buildGrid(data, startDate, endDate), [
    data,
    startDate,
    endDate,
  ]);

  if (grid.weeks.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center font-mono text-[11px] text-subtle">
        No closed trading days yet.
      </div>
    );
  }

  const totalDays = data.length;
  const profitableDays = data.filter((d) => d.pnl > 0).length;
  const losingDays = data.filter((d) => d.pnl < 0).length;
  const bestDay = data.reduce<DayCell | null>(
    (best, d) => (!best || d.pnl > best.pnl ? d : best),
    null,
  );
  const worstDay = data.reduce<DayCell | null>(
    (worst, d) => (!worst || d.pnl < worst.pnl ? d : worst),
    null,
  );

  return (
    <div className="flex flex-col gap-3">
      {/* The grid itself — horizontally scrollable for narrow viewports */}
      <div className="overflow-x-auto pb-1">
        <div
          className="flex flex-col gap-1"
          style={{ minWidth: grid.weeks.length * (SQUARE + GAP) + 30 }}
        >
          {/* Month labels row */}
          <div
            className="grid gap-[2px] pl-[30px]"
            style={{
              gridTemplateColumns: `repeat(${grid.weeks.length}, ${SQUARE}px)`,
              fontSize: 9.5,
              lineHeight: 1.2,
            }}
          >
            {grid.monthMarks.map((mark, idx) => (
              <span
                key={idx}
                className="label-eyebrow"
                style={{ gridColumnStart: mark.colStart }}
              >
                {MONTH_LABELS[mark.month]}
              </span>
            ))}
          </div>

          {/* Cell grid */}
          <div className="flex gap-[2px]">
            {/* Day-of-week labels (sparse) */}
            <div className="flex w-[28px] flex-col gap-[2px] pt-[2px]">
              {[0, 1, 2, 3, 4, 5, 6].map((dow) => (
                <span
                  key={dow}
                  className="font-mono text-[9px] uppercase tracking-widest text-subtle"
                  style={{ height: SQUARE, lineHeight: `${SQUARE}px` }}
                >
                  {dow === 1 || dow === 3 || dow === 5
                    ? DAY_LABELS[Math.floor((dow - 1) / 2)]
                    : ''}
                </span>
              ))}
            </div>

            {/* Weeks */}
            <div
              className="grid gap-[2px]"
              style={{
                gridTemplateColumns: `repeat(${grid.weeks.length}, ${SQUARE}px)`,
                gridTemplateRows: `repeat(7, ${SQUARE}px)`,
                gridAutoFlow: 'column',
              }}
            >
              {grid.weeks.flat().map((cell, i) => (
                <DayBox key={i} cell={cell} max={grid.maxAbs} />
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Summary + legend */}
      <div className="flex flex-col gap-2 border-t border-border pt-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10.5px] tracking-widest">
          <span className="text-muted-foreground">
            <span className="text-profit">{profitableDays}</span> green
            {' / '}
            <span className="text-loss">{losingDays}</span> red
            {' / '}
            <span className="text-foreground">{totalDays}</span> total
          </span>
          {bestDay && (
            <span className="text-muted-foreground">
              best{' '}
              <span className="text-profit tnum">
                +${bestDay.pnl.toFixed(0)}
              </span>{' '}
              <span className="text-subtle">{bestDay.date}</span>
            </span>
          )}
          {worstDay && worstDay.pnl < 0 && (
            <span className="text-muted-foreground">
              worst{' '}
              <span className="text-loss tnum">
                ${worstDay.pnl.toFixed(0)}
              </span>{' '}
              <span className="text-subtle">{worstDay.date}</span>
            </span>
          )}
        </div>
        <Legend max={grid.maxAbs} />
      </div>
    </div>
  );
}

function DayBox({ cell, max }: { cell: GridCell; max: number }) {
  if (cell.kind === 'outside') {
    return <span className="block bg-transparent" />;
  }
  if (cell.kind === 'empty') {
    return (
      <span
        className="block border border-border/60 bg-surface/40"
        title={`${cell.date} — no trades`}
      />
    );
  }
  // 'data'
  const ratio = max > 0 ? Math.min(1, Math.abs(cell.pnl) / max) : 0;
  const tier = ratio >= 0.85 ? 4 : ratio >= 0.55 ? 3 : ratio >= 0.25 ? 2 : ratio > 0 ? 1 : 0;
  const isProfit = cell.pnl >= 0;
  const bg =
    tier === 0
      ? 'oklch(0.30 0 0 / 0.5)'
      : isProfit
      ? `rgba(95, 217, 159, ${0.15 + tier * 0.20})`
      : `rgba(239, 115, 115, ${0.15 + tier * 0.20})`;
  return (
    <span
      className={cn(
        'group relative block border border-border/40 transition-transform hover:scale-[1.4] hover:border-signal hover:z-10',
      )}
      style={{ background: bg }}
    >
      <span className="pointer-events-none absolute -top-12 left-1/2 z-20 hidden -translate-x-1/2 whitespace-nowrap border border-border bg-card px-2 py-1 font-mono text-[10px] shadow-lg group-hover:block">
        <span className="text-subtle">{cell.date}</span>
        <span
          className={cn(
            'ml-2 tnum',
            cell.pnl >= 0 ? 'text-profit' : 'text-loss',
          )}
        >
          {cell.pnl >= 0 ? '+' : ''}${cell.pnl.toFixed(0)}
        </span>
        <span className="ml-2 text-muted-foreground">
          · {cell.trades}t
        </span>
      </span>
    </span>
  );
}

function Legend({ max }: { max: number }) {
  return (
    <div className="flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-widest text-subtle">
      <span>−${max.toFixed(0)}</span>
      <div className="flex gap-[2px]">
        {[-1, -0.6, -0.25, 0, 0.25, 0.6, 1].map((v, i) => {
          const ratio = Math.abs(v);
          const tier = ratio >= 0.85 ? 4 : ratio >= 0.55 ? 3 : ratio >= 0.25 ? 2 : ratio > 0 ? 1 : 0;
          const bg =
            tier === 0
              ? 'oklch(0.30 0 0 / 0.5)'
              : v >= 0
              ? `rgba(95, 217, 159, ${0.15 + tier * 0.20})`
              : `rgba(239, 115, 115, ${0.15 + tier * 0.20})`;
          return (
            <span
              key={i}
              className="block h-[10px] w-[10px] border border-border/40"
              style={{ background: bg }}
            />
          );
        })}
      </div>
      <span>+${max.toFixed(0)}</span>
    </div>
  );
}

// ─── grid construction ──────────────────────────────────────────────────

type GridCell =
  | { kind: 'data'; date: string; pnl: number; trades: number }
  | { kind: 'empty'; date: string }
  | { kind: 'outside' };

interface Grid {
  weeks: GridCell[][];      // each week is a 7-element array (Sun..Sat)
  maxAbs: number;
  monthMarks: { colStart: number; month: number }[];
}

function buildGrid(
  data: DayCell[],
  startDate: string,
  endDate: string,
): Grid {
  const start = parseISODate(startDate);
  const end = parseISODate(endDate);
  if (!start || !end) return { weeks: [], maxAbs: 1, monthMarks: [] };

  const dayMap = new Map<string, DayCell>();
  for (const d of data) dayMap.set(d.date, d);

  // Snap start to the prior Sunday so columns align as full weeks
  const colStart = new Date(start);
  colStart.setUTCDate(colStart.getUTCDate() - colStart.getUTCDay());

  const weeks: GridCell[][] = [];
  const monthMarks: { colStart: number; month: number }[] = [];
  let lastMonth = -1;
  let weekIdx = 0;

  let cursor = new Date(colStart);
  while (cursor <= end) {
    const week: GridCell[] = [];
    let weekHasMonthChange = false;
    for (let dow = 0; dow < 7; dow++) {
      const date = formatISODate(cursor);
      const inRange = cursor >= start && cursor <= end;
      const cell: GridCell = !inRange
        ? { kind: 'outside' }
        : dayMap.has(date)
        ? {
            kind: 'data',
            date,
            pnl: dayMap.get(date)!.pnl,
            trades: dayMap.get(date)!.trades,
          }
        : { kind: 'empty', date };
      week.push(cell);

      if (inRange && cursor.getUTCDay() === 0 && cursor.getUTCMonth() !== lastMonth) {
        // first Sunday of a new month → mark column for header
        weekHasMonthChange = true;
        lastMonth = cursor.getUTCMonth();
      }

      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    if (weekHasMonthChange) {
      monthMarks.push({ colStart: weekIdx + 1, month: lastMonth });
    }
    weeks.push(week);
    weekIdx++;
  }

  const maxAbs = Math.max(1, ...data.map((d) => Math.abs(d.pnl)));
  return { weeks, maxAbs, monthMarks };
}

function parseISODate(s: string): Date | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}

function formatISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
