'use client';

import { motion } from 'motion/react';
import {
  WatchingIllustration,
  CapitalIllustration,
  DisciplineIllustration,
  TestedIllustration,
} from './illustrations/principle-illustrations';

const PRINCIPLES = [
  {
    illustration: WatchingIllustration,
    title: 'Always watching.',
    body: 'A trading system is only as good as its observation. ShamarX runs a 24/7 candle ingest, broker reconciliation, and equity snapshot loop — every minute, without skipping.',
  },
  {
    illustration: CapitalIllustration,
    title: 'Capital is the priority.',
    body: 'Profit is a side-effect of survival. Per-trade risk is capped; daily loss has a circuit breaker; and a kill switch disarms the engine when drawdown crosses your line.',
  },
  {
    illustration: DisciplineIllustration,
    title: 'Discipline over hype.',
    body: 'No "100x" promises. No emotional execution. The same system runs at every killzone, in every regime, on every pair — until the data says stop.',
  },
  {
    illustration: TestedIllustration,
    title: 'Tested before trusted.',
    body: 'Every change is backtested across years of real-tick data and reconciled against live broker history. If it doesn’t survive backtest, it doesn’t reach your account.',
  },
];

export function PrinciplesSection() {
  return (
    <section
      id="principles"
      aria-label="Operating principles"
      className="relative scroll-mt-24 border-t border-border/60 py-24 sm:py-32"
    >
      <div className="mx-auto max-w-[1400px] px-5 sm:px-8 lg:px-12">
        <motion.header
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-100px' }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          className="mx-auto flex max-w-3xl flex-col items-start gap-4 sm:items-center sm:text-center"
        >
          <span className="shamarx-chip">Operating Principles</span>
          <h2 className="display-serif text-[34px] font-semibold leading-[1.05] tracking-[0.02em] sm:text-[42px] lg:text-[48px]">
            Quiet confidence.
            <br />
            <span className="text-signal">Loud results.</span>
          </h2>
          <p className="max-w-2xl text-[15px] leading-relaxed text-muted-foreground sm:text-[16px]">
            ShamarX runs on principles, not promises. These are the rules the system
            obeys — even when the operator wants to break them.
          </p>
        </motion.header>

        <div className="mt-16 grid grid-cols-1 gap-6 lg:grid-cols-2">
          {PRINCIPLES.map((p, i) => {
            const Illustration = p.illustration;
            return (
              <motion.div
                key={p.title}
                initial={{ opacity: 0, y: 24 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-60px' }}
                transition={{
                  duration: 0.7,
                  delay: i * 0.1,
                  ease: [0.16, 1, 0.3, 1],
                }}
                className="group relative flex gap-5 rounded-md border border-border bg-card/60 p-6 transition-colors hover:border-signal/40 hover:bg-card sm:p-8"
              >
                <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-md border border-border bg-background transition-colors group-hover:border-signal/40">
                  <Illustration />
                </div>
                <div className="min-w-0">
                  <h3 className="display-serif text-[20px] font-semibold leading-tight tracking-[0.02em] sm:text-[22px]">
                    {p.title}
                  </h3>
                  <p className="mt-2 text-[14px] leading-relaxed text-muted-foreground">
                    {p.body}
                  </p>
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
