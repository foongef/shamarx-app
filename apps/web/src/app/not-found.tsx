'use client';

import Link from 'next/link';
import { motion } from 'motion/react';
import { ArrowLeft, Home, LayoutDashboard, Search } from 'lucide-react';
import { ShamarxLogo } from '@/components/brand/shamarx-logo';
import { Lattice } from '@/components/landing/lattice';

const EASE = [0.16, 1, 0.3, 1] as const;
const GOLD = 'oklch(0.83 0.18 88)';

export default function NotFound() {
  return (
    <div className="fixed inset-0 z-[100] isolate flex flex-col overflow-y-auto bg-background">
      {/* Atmosphere */}
      <Lattice className="opacity-[0.28]" />
      <div className="pointer-events-none absolute -left-32 top-1/3 -z-10 h-[420px] w-[420px] rounded-full bg-signal/[0.08] blur-[120px]" />
      <div className="pointer-events-none absolute right-0 -bottom-24 -z-10 h-[420px] w-[420px] rounded-full bg-signal/[0.05] blur-[140px]" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-signal/40 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-signal/15 to-transparent" />

      {/* Top bar — minimal */}
      <header className="relative z-10 flex items-center justify-between px-5 pt-6 sm:px-10 sm:pt-8 lg:px-14">
        <Link href="/" className="inline-flex transition-opacity hover:opacity-90">
          <ShamarxLogo variant="horizontal" height={28} priority />
        </Link>
        <Link
          href="/"
          className="inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" />
          Back to site
        </Link>
      </header>

      {/* Main content */}
      <main className="relative z-10 flex flex-1 flex-col items-center justify-center px-6 pb-12 pt-10 text-center sm:pb-20">
        {/* Status bar — like a terminal log */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: EASE }}
          className="mb-10 inline-flex items-center gap-2.5 rounded-full border border-border bg-card/50 px-3.5 py-1.5 backdrop-blur-sm"
        >
          <span className="relative inline-block h-1.5 w-1.5 rounded-full bg-loss">
            <span className="absolute inset-0 animate-ping rounded-full bg-loss opacity-70" />
          </span>
          <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
            Signal · 404 · No fix on this route
          </span>
        </motion.div>

        {/* Big 404 with glitch + illustration */}
        <div className="relative mb-9 flex items-center justify-center">
          <OffGridIllustration />
          <motion.h1
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.9, delay: 0.15, ease: EASE }}
            className="relative z-10 display-serif text-[clamp(96px,18vw,200px)] font-bold leading-none tracking-[0.04em]"
          >
            <Glitch4 />
            <span className="text-signal">0</span>
            <Glitch4 />
          </motion.h1>
        </div>

        {/* Headline + body */}
        <motion.h2
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.4, ease: EASE }}
          className="display-serif text-[28px] font-semibold leading-[1.05] tracking-[0.02em] sm:text-[36px] lg:text-[42px]"
        >
          Off the <span className="text-signal">grid</span>.
        </motion.h2>
        <motion.p
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.5, ease: EASE }}
          className="mt-4 max-w-md text-[14.5px] leading-relaxed text-muted-foreground sm:text-[15px]"
        >
          The route you tried to read doesn&rsquo;t exist on this chart. No signal here —
          just static. Let&rsquo;s get you back to a place the system is watching.
        </motion.p>

        {/* CTA buttons */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.65, ease: EASE }}
          className="mt-9 flex flex-wrap items-center justify-center gap-3"
        >
          <Link
            href="/"
            className="group inline-flex items-center gap-2 rounded-md bg-signal px-6 py-3 font-mono text-[12px] font-semibold uppercase tracking-[0.22em] text-signal-foreground transition hover:brightness-110"
          >
            <Home className="h-3.5 w-3.5" strokeWidth={2.2} />
            Back to landing
          </Link>
          <Link
            href="/dashboard"
            className="group inline-flex items-center gap-2 rounded-md border border-border bg-card/50 px-6 py-3 font-mono text-[12px] uppercase tracking-[0.22em] text-foreground backdrop-blur-sm transition hover:border-signal/40 hover:bg-card/80"
          >
            <LayoutDashboard className="h-3.5 w-3.5" strokeWidth={2} />
            Go to dashboard
          </Link>
        </motion.div>

        {/* Suggested links — like a terminal sitemap */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.85, ease: EASE }}
          className="mt-12 inline-flex flex-col items-center gap-3"
        >
          <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-subtle">
            <Search className="mr-1.5 inline h-3 w-3 align-[-1px]" />
            Try one of these
          </span>
          <ul className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 font-mono text-[11.5px] text-muted-foreground">
            {[
              { href: '/#modules', label: 'Modules' },
              { href: '/#how', label: 'How it works' },
              { href: '/#strategy', label: 'Strategy' },
              { href: '/#principles', label: 'Principles' },
              { href: '/login', label: 'Sign in' },
            ].map((l) => (
              <li key={l.href}>
                <Link
                  href={l.href}
                  className="group inline-flex items-center gap-1.5 transition-colors hover:text-signal"
                >
                  <span className="opacity-50 transition-opacity group-hover:opacity-100">→</span>
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
        </motion.div>
      </main>

      {/* Footer marker */}
      <footer className="relative z-10 px-5 pb-6 text-center font-mono text-[9.5px] uppercase tracking-[0.32em] text-subtle sm:pb-8">
        Guarded by Design · ShamarX
      </footer>
    </div>
  );
}

/* ─── Glitching "4" — Orbitron, with subtle horizontal jitter ───── */
function Glitch4() {
  return (
    <motion.span
      animate={{ x: [0, -1.5, 0.8, 0, -0.6, 0] }}
      transition={{
        duration: 0.5,
        repeat: Infinity,
        repeatDelay: 4,
        ease: 'easeInOut',
      }}
      className="relative inline-block"
    >
      <span className="relative z-10">4</span>
      {/* duplicate offset glitch layers */}
      <motion.span
        aria-hidden
        animate={{ opacity: [0, 0.4, 0, 0] }}
        transition={{
          duration: 1.2,
          repeat: Infinity,
          repeatDelay: 4,
          ease: 'easeOut',
        }}
        className="absolute inset-0 -translate-x-[3px] text-signal/70 mix-blend-screen"
      >
        4
      </motion.span>
      <motion.span
        aria-hidden
        animate={{ opacity: [0, 0.3, 0, 0] }}
        transition={{
          duration: 1.2,
          repeat: Infinity,
          repeatDelay: 4,
          ease: 'easeOut',
          delay: 0.05,
        }}
        className="absolute inset-0 translate-x-[3px] text-loss/50 mix-blend-screen"
      >
        4
      </motion.span>
    </motion.span>
  );
}

/* ─── Off-grid illustration — broken signal arc behind the 404 ──── */
function OffGridIllustration() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 600 280"
      className="pointer-events-none absolute inset-0 -z-10 h-full w-full opacity-90"
      preserveAspectRatio="xMidYMid slice"
    >
      <defs>
        <linearGradient id="brk-line" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stopColor={GOLD} stopOpacity="0" />
          <stop offset="40%" stopColor={GOLD} stopOpacity="0.7" />
          <stop offset="100%" stopColor={GOLD} stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* horizontal scan line at the centre */}
      <line
        x1="0"
        x2="600"
        y1="140"
        y2="140"
        stroke="currentColor"
        strokeWidth="0.5"
        opacity="0.18"
        strokeDasharray="3 6"
        className="text-muted-foreground"
      />

      {/* "broken tape" — left arc rises, breaks, drops on the right */}
      <motion.path
        d="M30 200 L120 160 L180 180 L240 130"
        fill="none"
        stroke={GOLD}
        strokeWidth="1.1"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.7"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 1.2, ease: [0.4, 0, 0.2, 1] }}
      />
      {/* break gap with debris dots */}
      {[
        { x: 270, y: 138 },
        { x: 290, y: 150 },
        { x: 310, y: 142 },
      ].map((d, i) => (
        <motion.circle
          key={i}
          cx={d.x}
          cy={d.y}
          r="1.6"
          fill={GOLD}
          opacity="0.7"
          animate={{ y: [0, 4, 0], opacity: [0.5, 1, 0.5] }}
          transition={{
            duration: 2 + i * 0.3,
            repeat: Infinity,
            ease: 'easeInOut',
            delay: i * 0.2,
          }}
        />
      ))}
      <motion.path
        d="M340 165 L420 150 L480 190 L570 180"
        fill="none"
        stroke={GOLD}
        strokeWidth="1.1"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.7"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 1.2, delay: 0.4, ease: [0.4, 0, 0.2, 1] }}
      />

      {/* faint grid columns */}
      {[100, 200, 300, 400, 500].map((x) => (
        <line
          key={x}
          x1={x}
          x2={x}
          y1="40"
          y2="240"
          stroke="currentColor"
          strokeWidth="0.4"
          opacity="0.08"
          className="text-muted-foreground"
        />
      ))}

      {/* sweeping search beam */}
      <motion.line
        y1="40"
        y2="240"
        stroke="url(#brk-line)"
        strokeWidth="1"
        animate={{ x1: [0, 600], x2: [0, 600] }}
        transition={{ duration: 5, repeat: Infinity, ease: 'linear' }}
      />
    </svg>
  );
}
