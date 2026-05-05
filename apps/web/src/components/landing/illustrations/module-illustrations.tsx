'use client';

import { motion } from 'motion/react';

/**
 * Per-module mini illustrations — each is a small, intentional SVG
 * that animates on view. Kept simple: geometric, monoline, gold accent
 * only on the moving / load-bearing element.
 */

const STROKE = 'currentColor';
const LINE = 'oklch(0.83 0.18 88)'; // signal gold

const cardSize = { width: 120, height: 80 };

/* ─── 01 / Core — pulsing processor grid ──────────────────────────── */
export function CoreIllustration() {
  return (
    <svg
      width={cardSize.width}
      height={cardSize.height}
      viewBox="0 0 120 80"
      className="text-muted-foreground"
      aria-hidden
    >
      {/* outer chip */}
      <rect
        x="22"
        y="14"
        width="76"
        height="52"
        rx="3"
        fill="none"
        stroke={STROKE}
        strokeWidth="0.8"
        opacity="0.6"
      />
      {/* pins */}
      {Array.from({ length: 6 }).map((_, i) => (
        <g key={i} opacity="0.5">
          <line
            x1={22 - 5}
            x2={22}
            y1={22 + i * 7}
            y2={22 + i * 7}
            stroke={STROKE}
            strokeWidth="0.7"
          />
          <line
            x1={98}
            x2={103}
            y1={22 + i * 7}
            y2={22 + i * 7}
            stroke={STROKE}
            strokeWidth="0.7"
          />
        </g>
      ))}
      {/* inner core square */}
      <motion.rect
        x="46"
        y="28"
        width="28"
        height="24"
        rx="1"
        fill="none"
        stroke={LINE}
        strokeWidth="1"
        animate={{ opacity: [0.4, 1, 0.4] }}
        transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
      />
      {/* core glyph — small × cross */}
      <motion.path
        d="M54 36 L66 44 M66 36 L54 44"
        stroke={LINE}
        strokeWidth="1.4"
        strokeLinecap="round"
        animate={{ opacity: [0.6, 1, 0.6] }}
        transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
      />
    </svg>
  );
}

/* ─── 02 / Guard — shield with orbiting risk-cap ring ──────────────── */
export function GuardIllustration() {
  return (
    <svg
      width={cardSize.width}
      height={cardSize.height}
      viewBox="0 0 120 80"
      className="text-muted-foreground"
      aria-hidden
    >
      {/* shield outline */}
      <path
        d="M60 12 L80 22 V42 C80 56 60 68 60 68 C60 68 40 56 40 42 V22 Z"
        fill="none"
        stroke={STROKE}
        strokeWidth="0.9"
        opacity="0.55"
      />
      {/* check */}
      <motion.path
        d="M50 40 L57 47 L72 32"
        fill="none"
        stroke={LINE}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0 }}
        whileInView={{ pathLength: 1 }}
        viewport={{ once: true, margin: '-40px' }}
        transition={{ duration: 0.9, ease: [0.4, 0, 0.2, 1], delay: 0.2 }}
      />
      {/* orbital ring rotates */}
      <motion.g
        animate={{ rotate: 360 }}
        transition={{ duration: 14, repeat: Infinity, ease: 'linear' }}
        style={{ transformOrigin: '60px 40px' }}
      >
        <ellipse
          cx="60"
          cy="40"
          rx="34"
          ry="10"
          fill="none"
          stroke={LINE}
          strokeWidth="0.6"
          strokeDasharray="2 4"
          opacity="0.45"
        />
        <circle cx="94" cy="40" r="1.6" fill={LINE} />
      </motion.g>
    </svg>
  );
}

/* ─── 03 / Quant — animated bar chart drawing in ──────────────────── */
export function QuantIllustration() {
  const bars = [22, 36, 28, 48, 34, 56, 42];
  return (
    <svg
      width={cardSize.width}
      height={cardSize.height}
      viewBox="0 0 120 80"
      className="text-muted-foreground"
      aria-hidden
    >
      {/* baseline */}
      <line
        x1="20"
        x2="100"
        y1="64"
        y2="64"
        stroke={STROKE}
        strokeWidth="0.6"
        opacity="0.4"
      />
      {/* bars */}
      {bars.map((h, i) => {
        const isGold = i === bars.length - 1 || i === 3;
        return (
          <motion.rect
            key={i}
            x={22 + i * 11}
            y={64 - h}
            width="6"
            height={h}
            fill={isGold ? LINE : STROKE}
            opacity={isGold ? 0.95 : 0.35}
            initial={{ scaleY: 0, originY: '64px' }}
            whileInView={{ scaleY: 1 }}
            viewport={{ once: true, margin: '-40px' }}
            transition={{
              duration: 0.8,
              ease: [0.16, 1, 0.3, 1],
              delay: 0.1 + i * 0.06,
            }}
            style={{ transformBox: 'fill-box', transformOrigin: 'bottom' }}
          />
        );
      })}
      {/* trend line */}
      <motion.path
        d="M25 56 L36 44 L47 50 L58 32 L69 44 L80 24 L91 32"
        fill="none"
        stroke={LINE}
        strokeWidth="0.8"
        strokeLinecap="round"
        opacity="0.7"
        initial={{ pathLength: 0 }}
        whileInView={{ pathLength: 1 }}
        viewport={{ once: true, margin: '-40px' }}
        transition={{ duration: 1.2, delay: 0.6, ease: [0.4, 0, 0.2, 1] }}
      />
    </svg>
  );
}

/* ─── 04 / Pulse — ECG-style sweeping pulse line ──────────────────── */
export function PulseIllustration() {
  return (
    <svg
      width={cardSize.width}
      height={cardSize.height}
      viewBox="0 0 120 80"
      className="text-muted-foreground"
      aria-hidden
    >
      {/* baseline */}
      <line
        x1="14"
        x2="106"
        y1="40"
        y2="40"
        stroke={STROKE}
        strokeWidth="0.5"
        opacity="0.3"
        strokeDasharray="2 4"
      />
      {/* gridlines */}
      {[20, 60].map((y) => (
        <line
          key={y}
          x1="14"
          x2="106"
          y1={y}
          y2={y}
          stroke={STROKE}
          strokeWidth="0.4"
          opacity="0.18"
        />
      ))}
      {/* pulse path */}
      <motion.path
        d="M14 40 L34 40 L40 40 L44 22 L50 58 L56 40 L70 40 L76 32 L82 48 L88 40 L106 40"
        fill="none"
        stroke={LINE}
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0, opacity: 0 }}
        whileInView={{ pathLength: 1, opacity: 1 }}
        viewport={{ once: true, margin: '-40px' }}
        transition={{ duration: 1.2, delay: 0.2, ease: [0.4, 0, 0.2, 1] }}
        style={{ filter: 'drop-shadow(0 0 4px rgba(245,197,24,0.5))' }}
      />
      {/* sweeping cursor */}
      <motion.circle
        r="2.4"
        fill={LINE}
        animate={{
          cx: [14, 106],
          cy: [40, 40, 22, 58, 40, 40, 32, 48, 40, 40],
        }}
        transition={{
          duration: 3.2,
          repeat: Infinity,
          ease: 'linear',
        }}
        style={{ filter: 'drop-shadow(0 0 6px rgba(245,197,24,0.9))' }}
      />
    </svg>
  );
}
