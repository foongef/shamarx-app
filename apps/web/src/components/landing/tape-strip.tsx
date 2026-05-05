'use client';

import { motion } from 'motion/react';

/**
 * A scrolling pseudo-tape strip layered behind the hero — uppercase mono
 * fragments that drift across the canvas like a financial ticker.
 */
const TICKERS = [
  'XAUUSD · 2,418.66',
  'EURUSD · 1.0825',
  'GBPUSD · 1.2710',
  'USDJPY · 154.42',
  'GUARDED BY DESIGN',
  'SHAMARX // CORE',
  'RISK 1.5%',
  'KILLZONE · LDN',
  'SWEEP DETECTED',
  'CAPITAL · PROTECTED',
];

export function TapeStrip({
  reverse = false,
  speed = 60,
  className = '',
}: {
  reverse?: boolean;
  speed?: number;
  className?: string;
}) {
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute left-0 right-0 overflow-hidden whitespace-nowrap [mask-image:linear-gradient(to_right,transparent,black_8%,black_92%,transparent)] ${className}`}
    >
      <motion.div
        className="flex shrink-0 items-center gap-12"
        initial={{ x: reverse ? '-50%' : 0 }}
        animate={{ x: reverse ? 0 : '-50%' }}
        transition={{ ease: 'linear', duration: speed, repeat: Infinity }}
      >
        {[...TICKERS, ...TICKERS].map((t, i) => (
          <span
            key={i}
            className="font-mono text-[11px] uppercase tracking-[0.32em] text-muted-foreground/35"
          >
            <span className="text-signal/40">◆</span>
            <span className="ml-3">{t}</span>
          </span>
        ))}
      </motion.div>
    </div>
  );
}
