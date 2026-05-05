'use client';

import { motion, type Variants } from 'motion/react';

const EASE = [0.22, 1, 0.36, 1] as const;

const wordVariants: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.04, delayChildren: 0.25 } },
};

const letterVariants: Variants = {
  hidden: { y: '110%', opacity: 0, rotateX: -45 },
  visible: {
    y: 0,
    opacity: 1,
    rotateX: 0,
    transition: { duration: 0.75, ease: EASE },
  },
};

/**
 * Each "word" is its own overflow-hidden line so the letters appear to
 * tumble up from the baseline. Spaces preserved as their own non-animated
 * spans to maintain natural word spacing.
 */
function AnimatedWord({
  text,
  className = '',
}: {
  text: string;
  className?: string;
}) {
  return (
    <span className={`relative inline-flex overflow-hidden align-baseline ${className}`}>
      {Array.from(text).map((ch, i) => (
        <motion.span
          key={i}
          variants={letterVariants}
          className="inline-block will-change-transform"
        >
          {ch}
        </motion.span>
      ))}
    </span>
  );
}

export function AnimatedHeadline() {
  return (
    <motion.h1
      variants={wordVariants}
      initial="hidden"
      animate="visible"
      className="display-serif text-[clamp(40px,7vw,86px)] font-semibold leading-[0.94] tracking-[0.02em]"
      style={{ perspective: 800 }}
    >
      <span className="block">
        <AnimatedWord text="TRADE" />
        <span className="inline-block w-[0.28em]" />
        <AnimatedWord text="WITH" />
        <span className="inline-block w-[0.28em]" />
        <span className="relative inline-flex overflow-hidden">
          {Array.from('DISCIPLINE').map((ch, i) => (
            <motion.span
              key={i}
              variants={letterVariants}
              className="inline-block bg-gradient-to-b from-signal via-signal to-signal/80 bg-clip-text text-transparent will-change-transform"
            >
              {ch}
            </motion.span>
          ))}
          <motion.span
            aria-hidden
            initial={{ x: '-110%' }}
            animate={{ x: '210%' }}
            transition={{ delay: 1.4, duration: 1.6, ease: 'easeInOut' }}
            className="pointer-events-none absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-white/35 to-transparent mix-blend-overlay"
          />
        </span>
        <AnimatedWord text="." className="text-signal" />
      </span>
      <span className="mt-1 block">
        <AnimatedWord text="NOT" />
        <span className="inline-block w-[0.28em]" />
        <AnimatedWord text="EMOTION." />
      </span>
    </motion.h1>
  );
}
