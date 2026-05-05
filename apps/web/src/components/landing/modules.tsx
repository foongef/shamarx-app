'use client';

import { motion, type Variants } from 'motion/react';
import {
  CoreIllustration,
  GuardIllustration,
  QuantIllustration,
  PulseIllustration,
} from './illustrations/module-illustrations';

const EASE = [0.16, 1, 0.3, 1] as const;

const MODULES = [
  {
    id: 'core',
    name: 'ShamarX Core',
    label: '01',
    title: 'The execution engine',
    blurb:
      'Smart money concept reads the tape with anchored sweeps, structure shifts, and killzone bias — places orders only when the system is confident.',
    illustration: CoreIllustration,
  },
  {
    id: 'guard',
    name: 'ShamarX Guard',
    label: '02',
    title: 'Risk management built-in',
    blurb:
      'Per-trade risk caps, daily-loss limits, drawdown adaptive sizing, and a kill-switch that disarms the engine when conditions degrade.',
    illustration: GuardIllustration,
  },
  {
    id: 'quant',
    name: 'ShamarX Quant',
    label: '03',
    title: 'Test before you trust',
    blurb:
      'Backtest any strategy across years of real Dukascopy data. V6-alt SMC validated across XAUUSD, EURUSD, GBPUSD, USDJPY.',
    illustration: QuantIllustration,
  },
  {
    id: 'pulse',
    name: 'ShamarX Pulse',
    label: '04',
    title: 'Live signal observability',
    blurb:
      'Watch every candle evaluation, every reconcile, every fill — with broker reconciliation, equity arc, and per-pair breakdowns.',
    illustration: PulseIllustration,
  },
];

const cardFade: Variants = {
  hidden: { opacity: 0, y: 28 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.08, duration: 0.7, ease: EASE },
  }),
};

export function ModulesSection() {
  return (
    <section
      id="modules"
      aria-label="Shamarx product modules"
      className="relative scroll-mt-24 overflow-hidden py-24 sm:py-32"
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 mx-auto h-[420px] max-w-5xl rounded-full bg-signal/[0.04] blur-[120px]" />

      <div className="relative mx-auto max-w-[1400px] px-5 sm:px-8 lg:px-12">
        <motion.header
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-100px' }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          className="mx-auto flex max-w-3xl flex-col items-start gap-4 sm:items-center sm:text-center"
        >
          <span className="shamarx-chip">A Modular System</span>
          <h2 className="display-serif text-[34px] font-semibold leading-[1.05] tracking-[0.02em] sm:text-[44px] lg:text-[52px]">
            Four modules. <span className="text-signal">One discipline.</span>
          </h2>
          <p className="max-w-2xl text-[15px] leading-relaxed text-muted-foreground sm:text-[16px]">
            ShamarX is built like real fintech infrastructure — composed of clear,
            single-responsibility modules that you can trust independently and together.
          </p>
        </motion.header>

        <ul className="mt-16 grid grid-cols-1 gap-px overflow-hidden rounded-md border border-border bg-border md:grid-cols-2">
          {MODULES.map((m, i) => {
            const Illustration = m.illustration;
            return (
              <motion.li
                key={m.id}
                variants={cardFade}
                initial="hidden"
                whileInView="visible"
                viewport={{ once: true, margin: '-80px' }}
                custom={i}
                className="group relative bg-card p-7 transition-colors hover:bg-card/80 sm:p-9"
              >
                <span className="pointer-events-none absolute inset-x-0 top-0 h-px scale-x-0 bg-signal/70 transition-transform duration-500 group-hover:scale-x-100" />

                <div className="flex items-start justify-between gap-6">
                  <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
                    {m.name}
                  </span>
                  <span className="display-serif text-[28px] font-medium tracking-[0.04em] text-muted-foreground/40 transition-colors group-hover:text-signal/70">
                    {m.label}
                  </span>
                </div>

                {/* Animated SVG illustration */}
                <div className="mt-5 inline-flex items-center justify-start rounded-md border border-border bg-background/40 px-4 py-3 backdrop-blur-sm transition-colors group-hover:border-signal/25">
                  <Illustration />
                </div>

                <h3 className="mt-6 display-serif text-[22px] font-semibold leading-tight tracking-[0.02em] sm:text-[26px]">
                  {m.title}
                </h3>
                <p className="mt-3 max-w-md text-[14px] leading-relaxed text-muted-foreground sm:text-[14.5px]">
                  {m.blurb}
                </p>
              </motion.li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
