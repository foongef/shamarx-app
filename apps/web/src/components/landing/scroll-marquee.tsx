'use client';

import { motion } from 'motion/react';

/**
 * Infinite-scroll marquee — used for the "guarded by design" trust band.
 * Two duplicated tracks and a CSS keyframe-free motion loop.
 */
export function ScrollMarquee({
  items,
  className = '',
  duration = 35,
}: {
  items: string[];
  className?: string;
  duration?: number;
}) {
  return (
    <div
      className={`relative overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_8%,black_92%,transparent)] ${className}`}
    >
      <motion.div
        className="flex shrink-0 items-center gap-12 whitespace-nowrap"
        initial={{ x: 0 }}
        animate={{ x: '-50%' }}
        transition={{ ease: 'linear', duration, repeat: Infinity }}
      >
        {[...items, ...items].map((item, i) => (
          <span
            key={i}
            className="display-serif text-[18px] font-medium uppercase tracking-[0.18em] text-muted-foreground/80 sm:text-[22px]"
          >
            <span className="text-signal">◆</span>
            <span className="ml-3">{item}</span>
          </span>
        ))}
      </motion.div>
    </div>
  );
}
