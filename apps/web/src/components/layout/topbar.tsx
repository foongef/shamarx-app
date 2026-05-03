'use client';

import { Menu } from 'lucide-react';
import { ThemeToggle } from './theme-toggle';
import { TimeStamp } from './timestamp';

export function Topbar({ onOpenMobile }: { onOpenMobile: () => void }) {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border bg-background/80 px-4 backdrop-blur-md sm:px-6 lg:px-10">
      <div className="flex items-center gap-3">
        <button
          aria-label="Open navigation"
          onClick={onOpenMobile}
          className="text-muted-foreground hover:text-foreground lg:hidden"
        >
          <Menu className="h-4 w-4" />
        </button>
        <div className="hidden items-center gap-2 lg:flex">
          <span className="label-eyebrow">Terminal</span>
          <span className="text-subtle">/</span>
          <span className="font-mono text-[12px] tracking-wide text-muted-foreground">
            backtest.workspace
          </span>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <TimeStamp />
        <div className="hidden h-4 w-px bg-border md:block" />
        <ThemeToggle />
      </div>
    </header>
  );
}
