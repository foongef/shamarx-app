'use client';

import { motion } from 'motion/react';

const STROKE = 'currentColor';
const GOLD = 'oklch(0.83 0.18 88)';

const SIZE = 64;

/* ─── 01 / Always watching — radar with sweeping arm ──────────────── */
export function WatchingIllustration() {
  return (
    <div
      className="relative h-16 w-16 overflow-hidden text-muted-foreground"
      aria-hidden
    >
      {/* Conic sweep — rotates the bright wedge cleanly from centre.
          mask-image is a circle so the sweep can never escape the dial. */}
      <motion.div
        animate={{ rotate: 360 }}
        transition={{ duration: 3.5, repeat: Infinity, ease: 'linear' }}
        className="absolute inset-0 rounded-full"
        style={{
          background:
            'conic-gradient(from 0deg, rgba(245,197,24,0.85) 0deg, rgba(245,197,24,0.45) 18deg, rgba(245,197,24,0.18) 50deg, rgba(245,197,24,0) 110deg, rgba(245,197,24,0) 360deg)',
          // Mask to a circle within the 64×64 box (radius 26 like the SVG dial)
          WebkitMaskImage:
            'radial-gradient(circle at center, black 40%, black 81%, transparent 82%)',
          maskImage:
            'radial-gradient(circle at center, black 40%, black 81%, transparent 82%)',
        }}
      />

      {/* SVG overlay — rings, crosshair, blips, centre — all static */}
      <svg
        width="64"
        height="64"
        viewBox="0 0 64 64"
        className="absolute inset-0"
      >
        {/* outer dial border */}
        <circle
          cx="32"
          cy="32"
          r="26"
          fill="none"
          stroke={STROKE}
          strokeWidth="0.7"
          opacity="0.55"
        />
        {[18, 10].map((r, i) => (
          <circle
            key={r}
            cx="32"
            cy="32"
            r={r}
            fill="none"
            stroke={STROKE}
            strokeWidth="0.55"
            opacity={0.4 - i * 0.08}
          />
        ))}
        {/* Crosshair */}
        <line
          x1="6"
          x2="58"
          y1="32"
          y2="32"
          stroke={STROKE}
          strokeWidth="0.4"
          opacity="0.3"
        />
        <line
          x1="32"
          x2="32"
          y1="6"
          y2="58"
          stroke={STROKE}
          strokeWidth="0.4"
          opacity="0.3"
        />

        {/* Detected blips — fade in/out as the sweep passes */}
        {[
          { x: 44, y: 22, d: 0.8 },
          { x: 22, y: 18, d: 1.8 },
          { x: 20, y: 44, d: 2.6 },
        ].map((b) => (
          <motion.circle
            key={`${b.x}-${b.y}`}
            cx={b.x}
            cy={b.y}
            r="1.4"
            fill={GOLD}
            animate={{ opacity: [0, 1, 0] }}
            transition={{
              duration: 3.5,
              repeat: Infinity,
              ease: 'easeInOut',
              delay: b.d,
            }}
            style={{
              filter: 'drop-shadow(0 0 3px rgba(245,197,24,0.85))',
            }}
          />
        ))}

        {/* Pulsing centre dot — visual pivot of the sweep */}
        <motion.circle
          cx="32"
          cy="32"
          r="2.2"
          fill={GOLD}
          animate={{ scale: [1, 1.3, 1], opacity: [0.85, 1, 0.85] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
          style={{
            transformBox: 'fill-box',
            transformOrigin: '32px 32px',
            filter: 'drop-shadow(0 0 4px rgba(245,197,24,0.95))',
          }}
        />
      </svg>
    </div>
  );
}

/* ─── 02 / Capital priority — vault door with shield-check ────────── */
export function CapitalIllustration() {
  return (
    <svg
      width={SIZE}
      height={SIZE}
      viewBox="0 0 64 64"
      className="text-muted-foreground"
      aria-hidden
    >
      {/* vault outer */}
      <rect
        x="10"
        y="10"
        width="44"
        height="44"
        rx="3"
        fill="none"
        stroke={STROKE}
        strokeWidth="0.8"
        opacity="0.55"
      />
      {/* inner door */}
      <circle
        cx="32"
        cy="32"
        r="16"
        fill="none"
        stroke={STROKE}
        strokeWidth="0.7"
        opacity="0.4"
      />

      {/* spokes — slow rotation */}
      <motion.g
        animate={{ rotate: 360 }}
        transition={{ duration: 18, repeat: Infinity, ease: 'linear' }}
        style={{ transformOrigin: '32px 32px' }}
      >
        {[0, 60, 120, 180, 240, 300].map((a) => {
          const r1 = 8;
          const r2 = 16;
          const rad = (a * Math.PI) / 180;
          return (
            <line
              key={a}
              x1={32 + Math.cos(rad) * r1}
              y1={32 + Math.sin(rad) * r1}
              x2={32 + Math.cos(rad) * r2}
              y2={32 + Math.sin(rad) * r2}
              stroke={STROKE}
              strokeWidth="0.6"
              opacity="0.4"
            />
          );
        })}
      </motion.g>

      {/* core check (animated draw) */}
      <motion.circle
        cx="32"
        cy="32"
        r="7"
        fill={GOLD}
        opacity="0.12"
      />
      <motion.path
        d="M27 32 L31 36 L38 28"
        fill="none"
        stroke={GOLD}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0 }}
        whileInView={{ pathLength: 1 }}
        viewport={{ once: true, margin: '-40px' }}
        transition={{ duration: 0.9, ease: [0.4, 0, 0.2, 1], delay: 0.4 }}
      />

      {/* bolt indicators top/bottom — lock state */}
      {[
        { x: 32, y: 10 },
        { x: 32, y: 54 },
        { x: 10, y: 32 },
        { x: 54, y: 32 },
      ].map((p) => (
        <circle key={`${p.x}-${p.y}`} cx={p.x} cy={p.y} r="1.2" fill={GOLD} opacity="0.7" />
      ))}
    </svg>
  );
}

/* ─── 03 / Discipline — balance scale tipping into equilibrium ────── */
export function DisciplineIllustration() {
  return (
    <svg
      width={SIZE}
      height={SIZE}
      viewBox="0 0 64 64"
      className="text-muted-foreground"
      aria-hidden
    >
      {/* central pillar */}
      <line x1="32" x2="32" y1="14" y2="52" stroke={STROKE} strokeWidth="0.9" opacity="0.55" />
      {/* base */}
      <line x1="22" x2="42" y1="54" y2="54" stroke={STROKE} strokeWidth="1" opacity="0.55" />
      <line x1="22" x2="42" y1="56" y2="56" stroke={STROKE} strokeWidth="0.5" opacity="0.3" />

      {/* fulcrum — pivots gently to settle into balance */}
      <motion.g
        initial={{ rotate: -8 }}
        whileInView={{ rotate: [-8, 6, -3, 0] }}
        viewport={{ once: true, margin: '-40px' }}
        transition={{ duration: 1.6, ease: [0.16, 1, 0.3, 1] }}
        style={{ transformOrigin: '32px 14px' }}
      >
        {/* beam */}
        <line x1="14" x2="50" y1="14" y2="14" stroke={STROKE} strokeWidth="1" opacity="0.65" />
        {/* hangers */}
        <line x1="16" x2="16" y1="14" y2="22" stroke={STROKE} strokeWidth="0.6" opacity="0.5" />
        <line x1="48" x2="48" y1="14" y2="22" stroke={STROKE} strokeWidth="0.6" opacity="0.5" />
        {/* pans */}
        <path d="M10 22 L22 22 L19 28 L13 28 Z" fill="none" stroke={GOLD} strokeWidth="1" />
        <path d="M42 22 L54 22 L51 28 L45 28 Z" fill="none" stroke={GOLD} strokeWidth="1" />
        {/* pan content discs */}
        <circle cx="16" cy="22" r="1.2" fill={GOLD} />
        <circle cx="48" cy="22" r="1.2" fill={GOLD} />
      </motion.g>

      {/* pivot point */}
      <circle cx="32" cy="14" r="1.6" fill={GOLD} />

      {/* balance pulse */}
      <motion.circle
        cx="32"
        cy="14"
        r="3"
        fill="none"
        stroke={GOLD}
        strokeWidth="0.6"
        animate={{ scale: [1, 2.2, 1], opacity: [0.6, 0, 0.6] }}
        transition={{ duration: 2.6, repeat: Infinity, ease: 'easeOut', delay: 1.6 }}
        style={{ transformBox: 'fill-box', transformOrigin: '32px 14px' }}
      />
    </svg>
  );
}

/* ─── 04 / Tested — chart with validation tick ────────────────────── */
export function TestedIllustration() {
  return (
    <svg
      width={SIZE}
      height={SIZE}
      viewBox="0 0 64 64"
      className="text-muted-foreground"
      aria-hidden
    >
      {/* frame */}
      <rect
        x="8"
        y="10"
        width="48"
        height="36"
        rx="2"
        fill="none"
        stroke={STROKE}
        strokeWidth="0.7"
        opacity="0.5"
      />
      {/* gridlines */}
      {[18, 28, 38].map((y) => (
        <line
          key={y}
          x1="8"
          x2="56"
          y1={y}
          y2={y}
          stroke={STROKE}
          strokeWidth="0.3"
          opacity="0.25"
        />
      ))}

      {/* equity arc */}
      <motion.path
        d="M10 40 L18 36 L24 38 L30 30 L36 32 L42 22 L50 18 L54 14"
        fill="none"
        stroke={GOLD}
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0 }}
        whileInView={{ pathLength: 1 }}
        viewport={{ once: true, margin: '-40px' }}
        transition={{ duration: 1.4, ease: [0.4, 0, 0.2, 1] }}
      />

      {/* end-cap dot */}
      <motion.circle
        cx="54"
        cy="14"
        r="2"
        fill={GOLD}
        initial={{ scale: 0 }}
        whileInView={{ scale: [0, 1.5, 1] }}
        viewport={{ once: true, margin: '-40px' }}
        transition={{ duration: 0.6, delay: 1.4 }}
        style={{ transformBox: 'fill-box', transformOrigin: '54px 14px' }}
      />

      {/* validated badge */}
      <motion.g
        initial={{ opacity: 0, scale: 0.7 }}
        whileInView={{ opacity: 1, scale: 1 }}
        viewport={{ once: true, margin: '-40px' }}
        transition={{ duration: 0.6, delay: 1.6, ease: [0.16, 1, 0.3, 1] }}
        style={{ transformBox: 'fill-box', transformOrigin: '32px 54px' }}
      >
        <rect
          x="22"
          y="48"
          width="20"
          height="10"
          rx="5"
          fill={GOLD}
          opacity="0.18"
          stroke={GOLD}
          strokeWidth="0.6"
        />
        <path
          d="M27 53 L30 56 L37 50"
          fill="none"
          stroke={GOLD}
          strokeWidth="1"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </motion.g>
    </svg>
  );
}
