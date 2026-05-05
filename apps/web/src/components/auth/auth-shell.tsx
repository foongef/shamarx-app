'use client';

import Link from 'next/link';
import { motion } from 'motion/react';
import { ShamarxLogo } from '@/components/brand/shamarx-logo';
import { Lattice } from '@/components/landing/lattice';

const PRINCIPLES = [
  'Guarded by Design',
  'Discipline over Hype',
  'Capital Protection First',
];

/**
 * Shared two-pane chrome for all auth flow pages.
 *
 * Left  — atmospheric brand panel (vertical logo, tagline, principles)
 * Right — the actual form, slot in via children
 *
 * On mobile both stack into a single column.
 */
export function AuthShell({
  children,
  step,
  totalSteps = 3,
  stepLabels = ['Identify', 'Send', 'Verify'],
}: {
  children: React.ReactNode;
  step: number; // 1-indexed
  totalSteps?: number;
  stepLabels?: string[];
}) {
  return (
    <div className="grid min-h-screen grid-cols-1 bg-background lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      {/* ─── Brand panel ─── */}
      <aside className="relative isolate hidden flex-col justify-between overflow-hidden border-r border-border/60 bg-sidebar px-12 py-12 lg:flex">
        {/* Atmosphere */}
        <div className="pointer-events-none absolute inset-0 -z-10">
          <Lattice className="opacity-[0.32]" />
          <div className="absolute -left-24 top-1/3 h-[420px] w-[420px] rounded-full bg-signal/[0.10] blur-[110px]" />
          <div className="absolute -right-32 bottom-0 h-[360px] w-[360px] rounded-full bg-signal/[0.05] blur-[120px]" />
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-signal/40 to-transparent" />
        </div>

        {/* Top — Logo */}
        <Link href="/" className="inline-flex w-fit transition-opacity hover:opacity-90">
          <ShamarxLogo variant="horizontal" height={32} priority />
        </Link>

        {/* Mid — Vertical logo + tagline */}
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
          className="relative flex flex-col items-start gap-9"
        >
          <div className="relative">
            <motion.div
              aria-hidden
              animate={{ scale: [1, 1.05, 1], opacity: [0.4, 0.65, 0.4] }}
              transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut' }}
              className="pointer-events-none absolute inset-[-15%] -z-10 rounded-full bg-signal/[0.12] blur-[60px]"
            />
            <ShamarxLogo variant="symbol" height={120} />
          </div>

          <div>
            <span className="font-mono text-[10px] uppercase tracking-[0.32em] text-signal">
              Guarded by Design
            </span>
            <h2 className="mt-3 display-serif text-[32px] font-semibold leading-[1.05] tracking-[0.02em] xl:text-[38px]">
              Disciplined access.
              <br />
              <span className="text-signal">Always watching.</span>
            </h2>
            <p className="mt-4 max-w-md text-[14px] leading-relaxed text-muted-foreground">
              Your terminal is locked behind the same discipline that runs your trades.
              Take a breath. We&rsquo;ll get you back in.
            </p>
          </div>
        </motion.div>

        {/* Bottom — Principles list */}
        <ul className="flex flex-col gap-2.5 font-mono text-[10.5px] uppercase tracking-[0.22em] text-muted-foreground">
          {PRINCIPLES.map((p, i) => (
            <motion.li
              key={p}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{
                duration: 0.6,
                delay: 0.3 + i * 0.1,
                ease: [0.16, 1, 0.3, 1],
              }}
              className="flex items-center gap-2"
            >
              <span className="h-px w-5 bg-signal/60" />
              <span>{p}</span>
            </motion.li>
          ))}
        </ul>
      </aside>

      {/* ─── Form panel ─── */}
      <main className="relative flex min-h-screen flex-col px-5 pt-8 pb-10 sm:px-10 lg:px-14 lg:pt-12">
        {/* Mobile-only logo */}
        <div className="mb-10 flex items-center justify-between lg:hidden">
          <Link href="/" className="inline-flex transition-opacity hover:opacity-90">
            <ShamarxLogo variant="horizontal" height={26} priority />
          </Link>
          <Link
            href="/login"
            className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground transition-colors hover:text-foreground"
          >
            Sign in
          </Link>
        </div>

        {/* Desktop top-right meta */}
        <div className="absolute right-8 top-8 hidden items-center gap-3 lg:flex">
          <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
            Already a member?
          </span>
          <Link
            href="/login"
            className="rounded-full border border-border bg-card px-4 py-2 font-mono text-[10px] uppercase tracking-[0.22em] text-foreground transition hover:border-signal/40 hover:bg-card/70"
          >
            Sign in
          </Link>
        </div>

        <div className="mx-auto flex w-full max-w-[440px] flex-1 flex-col justify-center pt-12 lg:pt-0">
          <Stepper step={step} total={totalSteps} labels={stepLabels} />
          {children}
        </div>

        <footer className="mt-10 text-center font-mono text-[9.5px] uppercase tracking-[0.28em] text-subtle">
          © {new Date().getFullYear()} ShamarX · Phase 1
        </footer>
      </main>
    </div>
  );
}

/* ─── Stepper ─── */
function Stepper({
  step,
  total,
  labels,
}: {
  step: number;
  total: number;
  labels: string[];
}) {
  return (
    <div className="mb-9 flex items-center gap-3">
      {Array.from({ length: total }).map((_, i) => {
        const idx = i + 1;
        const active = idx === step;
        const done = idx < step;
        return (
          <div key={i} className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <motion.span
                initial={false}
                animate={{
                  scale: active ? 1.05 : 1,
                  backgroundColor: done
                    ? 'oklch(0.83 0.18 88)'
                    : active
                      ? 'oklch(0.83 0.18 88 / 0.15)'
                      : 'transparent',
                  borderColor: active || done
                    ? 'oklch(0.83 0.18 88)'
                    : 'oklch(0.27 0.008 75)',
                  color: done
                    ? 'oklch(0.13 0.006 65)'
                    : active
                      ? 'oklch(0.83 0.18 88)'
                      : 'oklch(0.44 0.008 75)',
                }}
                transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                className="flex h-6 w-6 items-center justify-center rounded-full border font-mono text-[10px] font-semibold tabular-nums"
              >
                {done ? '✓' : idx}
              </motion.span>
              <span
                className={`font-mono text-[9.5px] uppercase tracking-[0.22em] transition-colors ${
                  active
                    ? 'text-foreground'
                    : done
                      ? 'text-muted-foreground'
                      : 'text-subtle'
                }`}
              >
                {labels[i]}
              </span>
            </div>
            {idx < total && (
              <span
                className={`h-px w-6 transition-colors duration-500 ${
                  done ? 'bg-signal/70' : 'bg-border'
                }`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
