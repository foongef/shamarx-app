'use client';

import { useEffect, useState } from 'react';
import { animate, useMotionValue, useTransform, motion } from 'motion/react';

export function CountUp({
  value,
  decimals = 2,
  prefix = '',
  suffix = '',
  duration = 1.2,
  className,
}: {
  value: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  duration?: number;
  className?: string;
}) {
  const [target, setTarget] = useState(value);
  const motionValue = useMotionValue(0);
  const display = useTransform(motionValue, (v) => {
    const n = Math.abs(v);
    return `${v < 0 ? '−' : prefix}${n.toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })}${suffix}`;
  });

  useEffect(() => {
    const controls = animate(motionValue, value, {
      duration,
      ease: [0.16, 1, 0.3, 1],
    });
    setTarget(value);
    return () => controls.stop();
  }, [value, duration, motionValue]);

  return <motion.span className={className}>{display}</motion.span>;
}
