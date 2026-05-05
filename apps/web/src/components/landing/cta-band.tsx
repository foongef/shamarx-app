'use client';

import Link from 'next/link';
import { motion } from 'motion/react';
import { ArrowRight } from 'lucide-react';
import { ShamarxLogo } from '@/components/brand/shamarx-logo';
import { Lattice } from './lattice';

export function CtaBand() {
  return (
    <section
      aria-label="Get started with ShamarX"
      className="relative isolate overflow-hidden border-t border-border/60 py-24 sm:py-32"
    >
      <Lattice className="opacity-[0.45]" />
      <motion.div
        aria-hidden
        animate={{ opacity: [0.4, 0.65, 0.4] }}
        transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut' }}
        className="pointer-events-none absolute left-1/2 top-1/2 -z-10 h-[600px] w-[600px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-signal/[0.08] blur-[120px]"
      />

      <div className="relative mx-auto flex max-w-3xl flex-col items-center gap-8 px-6 text-center">
        <ShamarxLogo variant="symbol" height={56} />
        <motion.h2
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
          className="display-serif text-[36px] font-semibold leading-[1.04] tracking-[0.02em] sm:text-[48px] lg:text-[60px]"
        >
          Built for traders who value{' '}
          <span className="text-signal">consistency</span>.
        </motion.h2>
        <motion.p
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.8, delay: 0.15, ease: [0.16, 1, 0.3, 1] }}
          className="max-w-xl text-[15px] leading-relaxed text-muted-foreground sm:text-[16px]"
        >
          Discipline beats brilliance. ShamarX is the system that lets you trade like
          someone who&rsquo;s already won — quietly, controlled, every single day.
        </motion.p>
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.8, delay: 0.3, ease: [0.16, 1, 0.3, 1] }}
          className="flex flex-wrap items-center justify-center gap-3"
        >
          <Link
            href="/login"
            className="group inline-flex items-center gap-2 rounded-md bg-signal px-7 py-3.5 font-mono text-[12px] font-semibold uppercase tracking-[0.22em] text-signal-foreground transition hover:brightness-110"
          >
            Get Started
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
          <a
            href="#strategy"
            className="inline-flex items-center gap-2 rounded-md border border-border bg-card/40 px-7 py-3.5 font-mono text-[12px] uppercase tracking-[0.22em] text-foreground backdrop-blur-sm transition hover:border-border-strong hover:bg-card/80"
          >
            View Strategy
          </a>
        </motion.div>
      </div>
    </section>
  );
}
