'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, AlertCircle, ChevronDown, X } from 'lucide-react';
import { api } from '@/lib/api-client';
import { cn } from '@/lib/utils';

export function LoopHealthPill() {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['loop-health'],
    queryFn: () => api.liveLoopHealth(),
    refetchInterval: 15_000,
    refetchIntervalInBackground: true,
  });

  // Lock body scroll when mobile sheet is open
  useEffect(() => {
    if (!open) return;
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = original;
    };
  }, [open]);

  if (isLoading || !data) {
    return (
      <div className="inline-flex items-center gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground">
        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
        <span className="uppercase tracking-[0.16em]">Loop · …</span>
      </div>
    );
  }

  const tone = data.healthy ? 'profit' : 'warning';

  const detailContent = (
    <>
      <div className="label-eyebrow">Verdict</div>
      <div className={cn('mt-1 mb-3 text-[13px]', tone === 'profit' ? 'text-profit' : 'text-warning')}>
        {data.verdict}
      </div>

      <div className="label-eyebrow mb-1">Execution-service</div>
      <div className="mb-3 font-mono text-[12px]">
        <span className={data.executionReachable ? 'text-profit' : 'text-loss'}>
          {data.executionReachable ? '● reachable' : '✗ unreachable'}
        </span>
        <span className="mx-1.5 text-muted-foreground">·</span>
        <span className="text-muted-foreground">{data.executionMode}</span>
      </div>

      <div className="label-eyebrow mb-1">Last cron poll · per pair</div>
      <table className="w-full font-mono text-[11px]">
        <tbody>
          {data.pairs.map((p) => {
            const stale = p.ageSec === null || p.ageSec > 3 * 60;
            const ageStr =
              p.ageSec === null
                ? 'never'
                : p.ageSec < 60
                  ? `${p.ageSec}s ago`
                  : p.ageSec < 3600
                    ? `${Math.round(p.ageSec / 60)}m ago`
                    : `${Math.round(p.ageSec / 3600)}h ago`;
            return (
              <tr key={p.symbol} className="border-t border-border/40 first:border-0">
                <td className="py-1.5">{p.symbol}</td>
                <td className={cn('py-1.5 text-right tabular-nums', stale ? 'text-warning' : 'text-foreground')}>
                  {ageStr}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="mt-3 border-t border-border pt-2 text-[10px] leading-relaxed text-muted-foreground">
        Cron polls every 60s. &quot;Xs ago&quot; tracks the last successful poll —
        not the M15 bar age. If this says <strong className="text-foreground">OK</strong>{' '}
        but the chart shows &quot;Connection lost&quot;, trading is still running — only the
        dashboard fetch failed.
      </div>
    </>
  );

  return (
    <>
      {/* Pill */}
      <button
        onClick={() => setOpen((x) => !x)}
        className={cn(
          'inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 font-mono text-[11px] transition',
          tone === 'profit'
            ? 'border-profit/30 bg-profit/10 text-profit hover:bg-profit/15'
            : 'border-warning/30 bg-warning/10 text-warning hover:bg-warning/15',
        )}
        title="Backend trading-loop health (separate from chart polling)"
      >
        {data.healthy ? (
          <CheckCircle2 className="h-3.5 w-3.5" />
        ) : (
          <AlertCircle className="h-3.5 w-3.5" />
        )}
        <span className="uppercase tracking-[0.16em]">
          <span className="hidden sm:inline">Trading loop · </span>
          {data.healthy ? 'OK' : 'Degraded'}
        </span>
        <ChevronDown className={cn('h-3 w-3 transition', open && 'rotate-180')} />
      </button>

      {/* Desktop popover */}
      {open && (
        <>
          <div
            className="fixed inset-0 z-40 hidden md:block"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div className="absolute right-0 top-full z-50 mt-2 hidden w-[340px] rounded-md border border-border bg-card p-4 shadow-2xl ring-1 ring-border/50 md:block">
            {detailContent}
          </div>
        </>
      )}

      {/* Mobile bottom sheet */}
      {open && (
        <div className="fixed inset-0 z-50 flex flex-col md:hidden">
          {/* Backdrop */}
          <button
            onClick={() => setOpen(false)}
            className="flex-1 bg-black/60 backdrop-blur-sm"
            aria-label="Close"
          />
          {/* Sheet */}
          <div className="rounded-t-xl border-t border-border bg-card p-5 pb-safe shadow-2xl">
            {/* Drag handle */}
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-border" />
            <div className="mb-3 flex items-center justify-between">
              <span className="label-eyebrow">Trading loop health</span>
              <button
                onClick={() => setOpen(false)}
                className="rounded-md p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="hairline mb-4" />
            {detailContent}
          </div>
        </div>
      )}
    </>
  );
}
