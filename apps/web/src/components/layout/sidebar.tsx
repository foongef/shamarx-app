'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Activity,
  PlusSquare,
  CandlestickChart,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useBacktests } from '@/hooks/use-backtests';
import { StatusDot } from '@/components/backtest/status-dot';

const NAV = [
  { href: '/', label: 'Overview', icon: LayoutDashboard },
  { href: '/backtest', label: 'Runs', icon: Activity },
  { href: '/backtest/new', label: 'New Run', icon: PlusSquare },
];

export function Sidebar({
  mobileOpen,
  onCloseMobile,
}: {
  mobileOpen: boolean;
  onCloseMobile: () => void;
}) {
  const pathname = usePathname();
  const { data: runs } = useBacktests();
  const recent = (runs ?? []).slice(0, 6);

  return (
    <>
      {/* Mobile overlay */}
      <div
        className={cn(
          'fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden',
          mobileOpen ? 'block' : 'hidden',
        )}
        onClick={onCloseMobile}
      />
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 w-[228px] flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-transform lg:flex lg:translate-x-0',
          mobileOpen ? 'flex translate-x-0' : '-translate-x-full lg:translate-x-0',
        )}
      >
        {/* Brand */}
        <div className="flex h-14 items-center justify-between border-b border-sidebar-border px-5">
          <Link
            href="/"
            className="flex items-center gap-2 transition-opacity hover:opacity-80"
            onClick={onCloseMobile}
          >
            <CandlestickChart className="h-4 w-4 text-signal" strokeWidth={1.75} />
            <span className="display-serif text-[18px] leading-none tracking-tight">
              Tape
            </span>
          </Link>
          <button
            className="text-muted-foreground hover:text-foreground lg:hidden"
            onClick={onCloseMobile}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-col gap-1 px-3 py-4">
          <div className="label-eyebrow px-3 pb-2">Navigate</div>
          {NAV.map((item) => {
            const active =
              pathname === item.href ||
              (item.href !== '/' && pathname.startsWith(item.href));
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onCloseMobile}
                className={cn(
                  'group relative flex items-center gap-3 rounded-sm px-3 py-2 text-[13px] transition-colors',
                  active
                    ? 'bg-sidebar-accent text-foreground'
                    : 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground',
                )}
              >
                {active && (
                  <span className="absolute left-0 top-1.5 bottom-1.5 w-[2px] bg-signal" />
                )}
                <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </div>

        {/* Recent runs */}
        <div className="flex min-h-0 flex-1 flex-col gap-1 px-3 pb-4">
          <div className="flex items-center justify-between px-3 pb-2">
            <div className="label-eyebrow">Recent</div>
            {runs && runs.length > 0 && (
              <span className="font-mono text-[10px] tabular-nums text-subtle">
                {String(runs.length).padStart(2, '0')}
              </span>
            )}
          </div>
          <div className="flex flex-col gap-px overflow-y-auto pr-1">
            {recent.length === 0 && (
              <div className="px-3 py-4 text-[12px] text-subtle">
                No runs yet.
              </div>
            )}
            {recent.map((run) => {
              const active = pathname === `/backtest/${run.id}`;
              const ret = run.metrics?.returnPercent;
              return (
                <Link
                  key={run.id}
                  href={`/backtest/${run.id}`}
                  onClick={onCloseMobile}
                  className={cn(
                    'flex items-center justify-between rounded-sm px-3 py-1.5 text-[12px] transition-colors',
                    active
                      ? 'bg-sidebar-accent'
                      : 'hover:bg-sidebar-accent',
                  )}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <StatusDot status={run.status} />
                    <span className="truncate font-mono text-[11px]">
                      {run.symbol}·{run.id.slice(0, 5)}
                    </span>
                  </div>
                  {typeof ret === 'number' && (
                    <span
                      className={cn(
                        'font-mono text-[10.5px] tabular-nums',
                        ret >= 0 ? 'text-profit' : 'text-loss',
                      )}
                    >
                      {ret >= 0 ? '+' : ''}
                      {ret.toFixed(1)}%
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-sidebar-border px-5 py-3">
          <div className="flex items-center gap-2 text-[10.5px] text-subtle">
            <span className="relative inline-block h-1.5 w-1.5 rounded-full bg-signal">
              <span className="absolute inset-0 animate-ping rounded-full bg-signal opacity-60" />
            </span>
            <span className="font-mono uppercase tracking-widest">
              Live · v6-alt
            </span>
          </div>
        </div>
      </aside>
    </>
  );
}
