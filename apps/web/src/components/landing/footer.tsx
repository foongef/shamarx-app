'use client';

import Link from 'next/link';
import { ShamarxLogo } from '@/components/brand/shamarx-logo';

const COLS = [
  {
    label: 'Product',
    links: [
      { label: 'Modules', href: '#modules' },
      { label: 'How it works', href: '#how' },
      { label: 'Strategy', href: '#strategy' },
      { label: 'Principles', href: '#principles' },
    ],
  },
  {
    label: 'Workspace',
    links: [
      { label: 'Sign in', href: '/login' },
      { label: 'Dashboard', href: '/dashboard' },
      { label: 'Live cockpit', href: '/lives' },
      { label: 'Backtests', href: '/backtest' },
    ],
  },
  {
    label: 'About',
    links: [
      { label: 'Disclosure', href: '#disclosure' },
      { label: 'Contact', href: 'mailto:cipherriver@gmail.com' },
    ],
  },
];

export function LandingFooter() {
  return (
    <footer
      id="disclosure"
      className="relative border-t border-border/60 bg-background"
    >
      <div className="mx-auto max-w-[1400px] px-5 py-16 sm:px-8 lg:px-12">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <ShamarxLogo variant="horizontal" height={32} />
            <p className="mt-5 max-w-md text-[13.5px] leading-relaxed text-muted-foreground">
              ShamarX is a precision-driven trading system built to monitor markets,
              manage risk, and execute with discipline. Designed for traders who value
              consistency over hype.
            </p>
            <p className="mt-6 font-mono text-[10.5px] uppercase tracking-[0.22em] text-subtle">
              Sha-MAR-ex · Hebrew root <span className="text-foreground/80">shamar</span> · to guard, to watch
            </p>
          </div>

          <div className="grid grid-cols-3 gap-8 lg:col-span-7">
            {COLS.map((col) => (
              <div key={col.label}>
                <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
                  {col.label}
                </span>
                <ul className="mt-4 space-y-2.5">
                  {col.links.map((l) => (
                    <li key={l.label}>
                      {l.href.startsWith('#') || l.href.startsWith('mailto:') ? (
                        <a
                          href={l.href}
                          className="font-mono text-[12px] tracking-wide text-foreground transition-colors hover:text-signal"
                        >
                          {l.label}
                        </a>
                      ) : (
                        <Link
                          href={l.href}
                          className="font-mono text-[12px] tracking-wide text-foreground transition-colors hover:text-signal"
                        >
                          {l.label}
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-14 border-t border-border/60 pt-7">
          <p className="font-mono text-[10.5px] leading-relaxed text-subtle">
            <span className="text-muted-foreground">Risk disclosure.</span>{' '}
            Trading foreign exchange and CFDs carries a high level of risk and may not
            be suitable for all investors. Past performance from backtests is not
            indicative of future results. ShamarX is a tool, not financial advice.
            You are responsible for the trades placed through your own broker account.
          </p>
          <div className="mt-6 flex flex-col items-start justify-between gap-2 font-mono text-[10.5px] uppercase tracking-[0.22em] text-muted-foreground sm:flex-row sm:items-center">
            <span>© {new Date().getFullYear()} ShamarX · Guarded by Design</span>
            <span className="text-subtle">v0.6 · Phase 1</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
