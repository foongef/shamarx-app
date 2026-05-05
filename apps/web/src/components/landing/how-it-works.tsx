'use client';

import { motion } from 'motion/react';
import {
  WatchIllustration,
  FilterIllustration,
  ExecuteIllustration,
} from './illustrations/step-illustrations';

const STEPS = [
  {
    n: '01',
    label: 'Watch',
    title: 'It watches the market — without flinching.',
    body:
      'A 24/7 candle ingest pipeline streams XAUUSD, EURUSD, GBPUSD, and USDJPY into the engine. Every M15 close is evaluated against multi-timeframe context — H1 sweeps, H4 bias, D1 ADX regime.',
    illustration: WatchIllustration,
  },
  {
    n: '02',
    label: 'Filter',
    title: 'It filters the noise — only conviction passes.',
    body:
      'Smart money sweeps, killzone bias, news blackouts, anchor levels, regime stability. A trade has to clear every gate. If the signal is mid, it is rejected. Discipline is the default.',
    illustration: FilterIllustration,
  },
  {
    n: '03',
    label: 'Execute',
    title: 'It executes with precision — and protects what it has.',
    body:
      'Risk-sized lot. Stop loss at structure, not behind a round number. Drawdown-adaptive sizing, daily-loss limits, kill switch on regime break. The system knows when to stop.',
    illustration: ExecuteIllustration,
  },
];

export function HowItWorksSection() {
  return (
    <section
      id="how"
      aria-label="How ShamarX works"
      className="relative scroll-mt-24 border-t border-border/60 py-24 sm:py-32"
    >
      <div className="mx-auto max-w-[1400px] px-5 sm:px-8 lg:px-12">
        <motion.header
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-100px' }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          className="grid grid-cols-12 gap-x-6"
        >
          <div className="col-span-12 lg:col-span-5">
            <span className="shamarx-chip">How it works</span>
            <h2 className="mt-4 display-serif text-[34px] font-semibold leading-[1.05] tracking-[0.02em] sm:text-[42px] lg:text-[48px]">
              Three steps.
              <br />
              <span className="text-signal">No emotion.</span>
            </h2>
          </div>
          <p className="col-span-12 mt-6 max-w-xl text-[15px] leading-relaxed text-muted-foreground sm:text-[16px] lg:col-span-6 lg:col-start-7 lg:mt-0">
            ShamarX is named for <em>shamar</em> — to guard, to watch.{' '}
            That is exactly what it does. Every trade follows the same controlled, three-step
            ritual. The market changes. The discipline does not.
          </p>
        </motion.header>

        <ol className="relative mt-20 grid grid-cols-1 gap-12 lg:grid-cols-3 lg:gap-10">
          {/* Connector line — desktop only */}
          <div
            aria-hidden
            className="pointer-events-none absolute left-[3.6rem] right-10 top-[1.6rem] hidden h-px lg:block"
          >
            <div className="h-full bg-gradient-to-r from-signal/60 via-signal/30 to-signal/0" />
          </div>

          {STEPS.map((s, i) => {
            const Illustration = s.illustration;
            return (
              <motion.li
                key={s.n}
                initial={{ opacity: 0, y: 24 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-60px' }}
                transition={{
                  duration: 0.7,
                  delay: i * 0.15,
                  ease: [0.16, 1, 0.3, 1],
                }}
                className="relative flex flex-col gap-5"
              >
                <div className="flex items-center gap-4">
                  <span className="flex h-12 w-12 items-center justify-center rounded-full border border-signal/30 bg-background font-mono text-[12px] font-semibold text-signal">
                    {s.n}
                  </span>
                  <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
                    {s.label}
                  </span>
                </div>

                {/* Step illustration */}
                <div className="inline-flex w-fit items-center justify-start rounded-md border border-border bg-card/40 px-4 py-3 backdrop-blur-sm">
                  <Illustration />
                </div>

                <h3 className="display-serif text-[22px] font-semibold leading-tight tracking-[0.02em] sm:text-[24px]">
                  {s.title}
                </h3>
                <p className="text-[14px] leading-relaxed text-muted-foreground sm:text-[14.5px]">
                  {s.body}
                </p>
              </motion.li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
