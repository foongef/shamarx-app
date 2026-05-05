'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Activity,
  PlusSquare,
  CandlestickChart,
  Radio,
  X,
  LogOut,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useBacktests } from '@/hooks/use-backtests';
import { useAuth } from '@/contexts/AuthContext';
import { StatusDot } from '@/components/backtest/status-dot';

const NAV = [
  { href: '/', label: 'Overview', icon: LayoutDashboard },
  { href: '/lives', label: 'Live', icon: Radio },
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
  const { user, logout } = useAuth();
  const recent = (runs ?? []).slice(0, 6);

  return (
    <>
      {/* Mobile overlay backdrop */}
      <div
        className={cn(
          'fixed inset-0 z-40 bg-black/65 backdrop-blur-sm transition-opacity lg:hidden',
          mobileOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        onClick={onCloseMobile}
      />

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-[260px] flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-transform duration-200 lg:w-[228px] lg:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
        )}
        aria-label="Primary navigation"
      >
        {/* Brand */}
        <div className="flex h-14 items-center justify-between border-b border-sidebar-border pl-5 pr-3">
          <Link
            href="/"
            onClick={onCloseMobile}
            className="flex items-center gap-2 transition-opacity hover:opacity-80"
          >
            <CandlestickChart className="h-4 w-4 text-signal" strokeWidth={1.75} />
            <span className="display-serif text-[20px] leading-none tracking-tight">
              Tape
            </span>
            <span className="ml-1 font-mono text-[9px] text-muted-foreground">·v0.6</span>
          </Link>
          <button
            className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground lg:hidden"
            onClick={onCloseMobile}
            aria-label="Close navigation"
          >
            <X className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </div>

        {/* Nav */}
        <div className="flex flex-col gap-0.5 px-3 pt-4 pb-2">
          <div className="label-eyebrow px-3 pb-2">Workspace</div>
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
                  'group relative flex items-center gap-3 rounded-sm px-3 py-2.5 text-[13px] transition-colors lg:py-2',
                  active
                    ? 'bg-sidebar-accent text-foreground'
                    : 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground',
                )}
              >
                {active && (
                  <span className="absolute left-0 top-1.5 bottom-1.5 w-[2px] bg-signal" />
                )}
                <Icon className="h-4 w-4 lg:h-3.5 lg:w-3.5" strokeWidth={1.75} />
                <span>{item.label}</span>
                {item.href === '/lives' && (
                  <span className="ml-auto inline-block h-1.5 w-1.5 rounded-full bg-signal/60" />
                )}
              </Link>
            );
          })}
        </div>

        {/* Recent runs */}
        <div className="flex min-h-0 flex-1 flex-col gap-1 px-3 pb-4">
          <div className="flex items-center justify-between px-3 pt-3 pb-2">
            <div className="label-eyebrow">Recent</div>
            {runs && runs.length > 0 && (
              <span className="font-mono text-[10px] tabular-nums text-subtle">
                {String(runs.length).padStart(2, '0')}
              </span>
            )}
          </div>
          <div className="flex flex-col gap-px overflow-y-auto pr-1">
            {recent.length === 0 && (
              <div className="px-3 py-4 text-[12px] text-subtle">No runs yet.</div>
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

        {/* User + footer */}
        <div className="border-t border-sidebar-border">
          {user && (
            <div className="flex items-center justify-between gap-2 px-5 py-3 lg:hidden">
              <div className="min-w-0 flex-1 leading-tight">
                <div className="truncate font-mono text-[11px] text-foreground">
                  {user.email}
                </div>
                <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
                  {user.role}
                </div>
              </div>
              <button
                onClick={() => {
                  onCloseMobile();
                  logout();
                }}
                aria-label="Sign out"
                className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
              >
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          )}
          <div className="flex items-center gap-2 border-t border-sidebar-border px-5 py-3 text-[10.5px] text-subtle lg:border-t-0">
            <span className="relative inline-block h-1.5 w-1.5 rounded-full bg-signal">
              <span className="absolute inset-0 animate-ping rounded-full bg-signal opacity-60" />
            </span>
            <span className="font-mono uppercase tracking-widest">Live · v6-alt</span>
          </div>
        </div>
      </aside>
    </>
  );
}
