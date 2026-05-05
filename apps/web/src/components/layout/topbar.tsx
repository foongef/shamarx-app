'use client';

import Link from 'next/link';
import { LogOut, Menu, CandlestickChart } from 'lucide-react';
import { ThemeToggle } from './theme-toggle';
import { TimeStamp } from './timestamp';
import { useAuth } from '@/contexts/AuthContext';

export function Topbar({ onOpenMobile }: { onOpenMobile: () => void }) {
  const { user, logout } = useAuth();
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b border-border bg-background/85 px-3 backdrop-blur-md sm:px-6 lg:px-10">
      {/* Left */}
      <div className="flex min-w-0 items-center gap-2">
        <button
          onClick={onOpenMobile}
          aria-label="Open navigation"
          className="-ml-1 inline-flex items-center justify-center rounded-md p-2 text-muted-foreground transition hover:bg-muted hover:text-foreground lg:hidden"
        >
          <Menu className="h-4 w-4" strokeWidth={1.75} />
        </button>
        <Link href="/" className="flex items-center gap-2 lg:hidden">
          <CandlestickChart className="h-4 w-4 text-signal" strokeWidth={1.75} />
          <span className="display-serif text-[18px] leading-none tracking-tight">
            Tape
          </span>
        </Link>
        <div className="hidden items-center gap-2 lg:flex">
          <span className="label-eyebrow">Terminal</span>
          <span className="text-subtle">/</span>
          <span className="font-mono text-[12px] tracking-wide text-muted-foreground">
            backtest.workspace
          </span>
        </div>
      </div>

      {/* Right */}
      <div className="flex shrink-0 items-center gap-1.5 sm:gap-3">
        <TimeStamp />
        <div className="hidden h-4 w-px bg-border md:block" />
        <ThemeToggle />
        {user && (
          <>
            <div className="hidden h-4 w-px bg-border md:block" />
            <div className="hidden flex-col items-end leading-tight md:flex">
              <span className="font-mono text-[11px] text-foreground">
                {user.email}
              </span>
              <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
                {user.role}
              </span>
            </div>
            <button
              onClick={logout}
              aria-label="Sign out"
              title="Sign out"
              className="hidden rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground md:inline-flex"
            >
              <LogOut className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>
    </header>
  );
}
