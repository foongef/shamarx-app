'use client';

import { motion } from 'motion/react';

const STROKE = 'currentColor';
const LINE = 'oklch(0.83 0.18 88)'; // signal gold

/* ─── Step 01 / Watch — opening eye with scanning beam ───────────── */
export function WatchIllustration() {
  return (
    <svg
      width="100"
      height="64"
      viewBox="0 0 100 64"
      className="text-muted-foreground"
      aria-hidden
    >
      {/* eye outline */}
      <motion.path
        d="M14 32 C28 12 72 12 86 32 C72 52 28 52 14 32 Z"
        fill="none"
        stroke={STROKE}
        strokeWidth="0.9"
        opacity="0.55"
        initial={{ pathLength: 0 }}
        whileInView={{ pathLength: 1 }}
        viewport={{ once: true, margin: '-40px' }}
        transition={{ duration: 1.0, ease: [0.4, 0, 0.2, 1] }}
      />
      {/* iris */}
      <motion.circle
        cx="50"
        cy="32"
        r="12"
        fill="none"
        stroke={LINE}
        strokeWidth="1"
        initial={{ scale: 0, opacity: 0 }}
        whileInView={{ scale: 1, opacity: 1 }}
        viewport={{ once: true, margin: '-40px' }}
        transition={{ duration: 0.6, delay: 0.5, ease: [0.16, 1, 0.3, 1] }}
        style={{ transformBox: 'fill-box', transformOrigin: '50% 50%' }}
      />
      {/* pupil */}
      <motion.circle
        cx="50"
        cy="32"
        r="2.4"
        fill={LINE}
        animate={{ opacity: [0.5, 1, 0.5] }}
        transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
      />
      {/* scanning vertical beam */}
      <motion.line
        x1="50"
        x2="50"
        y1="14"
        y2="50"
        stroke={LINE}
        strokeWidth="0.5"
        strokeDasharray="2 3"
        opacity="0.6"
        animate={{ x1: [22, 78, 22], x2: [22, 78, 22] }}
        transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
      />
    </svg>
  );
}

/* ─── Step 02 / Filter — funnel with falling particles ───────────── */
export function FilterIllustration() {
  return (
    <svg
      width="100"
      height="64"
      viewBox="0 0 100 64"
      className="text-muted-foreground"
      aria-hidden
    >
      {/* funnel walls */}
      <motion.path
        d="M22 10 L78 10 L60 36 L60 56 L40 56 L40 36 Z"
        fill="none"
        stroke={STROKE}
        strokeWidth="0.9"
        opacity="0.5"
        initial={{ pathLength: 0 }}
        whileInView={{ pathLength: 1 }}
        viewport={{ once: true, margin: '-40px' }}
        transition={{ duration: 1.1, ease: [0.4, 0, 0.2, 1] }}
      />
      {/* incoming particles */}
      {[28, 42, 58, 72].map((x, i) => (
        <motion.circle
          key={i}
          cx={x}
          r="1.4"
          fill={i === 1 ? LINE : STROKE}
          opacity={i === 1 ? 1 : 0.4}
          animate={{ cy: [-2, i === 1 ? 56 : 36] }}
          transition={{
            duration: 2.4 + i * 0.3,
            repeat: Infinity,
            ease: 'easeIn',
            delay: i * 0.45,
          }}
        />
      ))}
      {/* gold filtered output */}
      <motion.line
        x1="50"
        x2="50"
        y1="56"
        y2="62"
        stroke={LINE}
        strokeWidth="1.6"
        strokeLinecap="round"
        animate={{ opacity: [0.5, 1, 0.5] }}
        transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
      />
    </svg>
  );
}

/* ─── Step 03 / Execute — target with arrow strike ───────────────── */
export function ExecuteIllustration() {
  return (
    <svg
      width="100"
      height="64"
      viewBox="0 0 100 64"
      className="text-muted-foreground"
      aria-hidden
    >
      {/* concentric target rings */}
      {[20, 14, 8].map((r, i) => (
        <motion.circle
          key={i}
          cx="62"
          cy="32"
          r={r}
          fill="none"
          stroke={i === 2 ? LINE : STROKE}
          strokeWidth={i === 2 ? 1 : 0.7}
          opacity={i === 2 ? 0.9 : 0.45 - i * 0.1}
          initial={{ scale: 0, opacity: 0 }}
          whileInView={{ scale: 1, opacity: i === 2 ? 0.9 : 0.45 - i * 0.1 }}
          viewport={{ once: true, margin: '-40px' }}
          transition={{
            duration: 0.7,
            delay: 0.15 + i * 0.15,
            ease: [0.16, 1, 0.3, 1],
          }}
          style={{ transformBox: 'fill-box', transformOrigin: '62px 32px' }}
        />
      ))}
      {/* center dot */}
      <motion.circle
        cx="62"
        cy="32"
        r="2"
        fill={LINE}
        animate={{ scale: [1, 1.6, 1], opacity: [0.7, 1, 0.7] }}
        transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
        style={{ transformBox: 'fill-box', transformOrigin: '62px 32px' }}
      />
      {/* incoming arrow */}
      <motion.path
        d="M14 32 L52 32"
        stroke={LINE}
        strokeWidth="1.4"
        strokeLinecap="round"
        initial={{ pathLength: 0, opacity: 0 }}
        whileInView={{ pathLength: 1, opacity: 1 }}
        viewport={{ once: true, margin: '-40px' }}
        transition={{ duration: 0.7, delay: 0.8, ease: [0.4, 0, 0.2, 1] }}
      />
      <motion.path
        d="M48 28 L54 32 L48 36"
        fill="none"
        stroke={LINE}
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true, margin: '-40px' }}
        transition={{ duration: 0.4, delay: 1.4 }}
      />
    </svg>
  );
}
