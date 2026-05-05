'use client';

import { motion } from 'motion/react';

const STROKE = 'currentColor';
const GOLD = 'oklch(0.83 0.18 88)';

/**
 * Minimal animated key-in-lock illustration. The key slides in, the lock's
 * shackle subtly responds, and a gold ring radiates from the keyhole when
 * the form is submitted.
 *
 * Pass `variant`:
 *   • 'idle'     — quiet idle state with a slow keyhole pulse
 *   • 'sending'  — key shakes slightly, ring pulses faster
 *   • 'success'  — shackle opens, gold confirmation bloom
 */
export function KeyIllustration({
  variant = 'idle',
}: {
  variant?: 'idle' | 'sending' | 'success';
}) {
  const sending = variant === 'sending';
  const success = variant === 'success';

  return (
    <svg
      width="84"
      height="84"
      viewBox="0 0 84 84"
      className="text-muted-foreground"
      aria-hidden
    >
      {/* Lock body */}
      <motion.rect
        x="22"
        y="38"
        width="40"
        height="34"
        rx="3"
        fill="none"
        stroke={STROKE}
        strokeWidth="1"
        opacity="0.55"
      />

      {/* Shackle — animates open on success */}
      <motion.path
        d="M30 38 V28 C30 20 38 14 42 14 C46 14 54 20 54 28 V38"
        fill="none"
        stroke={STROKE}
        strokeWidth="1"
        opacity="0.55"
        animate={{
          d: success
            ? 'M30 38 V28 C30 20 38 14 42 14 C46 14 54 14 54 14 V38'
            : 'M30 38 V28 C30 20 38 14 42 14 C46 14 54 20 54 28 V38',
        }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      />

      {/* Keyhole circle */}
      <motion.circle
        cx="42"
        cy="52"
        r="3.5"
        fill="none"
        stroke={GOLD}
        strokeWidth="1.2"
        animate={{
          opacity: sending ? [0.6, 1, 0.6] : success ? 1 : [0.5, 0.85, 0.5],
        }}
        transition={{
          duration: sending ? 0.8 : 2.4,
          repeat: success ? 0 : Infinity,
          ease: 'easeInOut',
        }}
      />
      <motion.path
        d="M42 55 L42 60"
        stroke={GOLD}
        strokeWidth="1.4"
        strokeLinecap="round"
        animate={{ opacity: success ? 1 : [0.5, 0.85, 0.5] }}
        transition={{ duration: 2.4, repeat: success ? 0 : Infinity }}
      />

      {/* Radiating ring on success */}
      {success && (
        <motion.circle
          cx="42"
          cy="52"
          r="3.5"
          fill="none"
          stroke={GOLD}
          strokeWidth="1"
          initial={{ scale: 1, opacity: 0.9 }}
          animate={{ scale: 5, opacity: 0 }}
          transition={{ duration: 1.2, ease: 'easeOut' }}
          style={{ transformBox: 'fill-box', transformOrigin: '42px 52px' }}
        />
      )}

      {/* Key — slides in from the side and gently jiggles when sending */}
      <motion.g
        initial={{ x: -22, opacity: 0 }}
        animate={
          success
            ? { x: 0, opacity: 0 }
            : sending
              ? { x: [-2, 2, -2, 2, 0], opacity: 1 }
              : { x: 0, opacity: 0.85 }
        }
        transition={
          sending
            ? { duration: 0.6, repeat: Infinity }
            : { duration: 0.8, ease: [0.16, 1, 0.3, 1] }
        }
      >
        {/* shaft */}
        <line x1="64" x2="80" y1="52" y2="52" stroke={GOLD} strokeWidth="1.3" />
        {/* teeth */}
        <line x1="76" x2="76" y1="52" y2="56" stroke={GOLD} strokeWidth="1.3" />
        <line x1="72" x2="72" y1="52" y2="55" stroke={GOLD} strokeWidth="1.3" />
        {/* bow */}
        <circle
          cx="82"
          cy="52"
          r="3.5"
          fill="none"
          stroke={GOLD}
          strokeWidth="1.3"
        />
      </motion.g>
    </svg>
  );
}
