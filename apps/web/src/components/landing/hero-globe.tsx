'use client';

import { useEffect, useRef } from 'react';
import {
  motion,
  useMotionValue,
  useSpring,
  useTransform,
} from 'motion/react';

/**
 * 3D wireframe globe — built with pure CSS 3D transforms (no Three.js).
 *
 *  • 8 longitude rings (great circles rotated around Y at 22.5° increments)
 *  • 5 latitude rings (ellipses at varying heights, projected as horizontals)
 *  • Pulsing gold markers at the four FX killzones — Sydney, Tokyo, London, NY
 *  • Gentle continuous Y-rotation; entire stage tilts with the cursor
 *
 * The globe is sized to sit BEHIND the Shamarx logo and read as a quiet
 * structural presence, not decoration.
 */

const RADIUS = 200;

// Major FX killzones — used as glowing markers around the equator.
type Marker = { city: string; lon: number; lat: number };
const KILLZONES: Marker[] = [
  { city: 'SYD', lon: 151, lat: -33 },
  { city: 'TKY', lon: 139, lat: 35 },
  { city: 'LDN', lon: 0, lat: 51 },
  { city: 'NY',  lon: -74, lat: 40 },
  { city: 'FFM', lon: 8, lat: 50 }, // Frankfurt — extra anchor
];

// Polar → cartesian projection on a sphere of given radius.
function project(lat: number, lon: number, r: number) {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lon + 180) * (Math.PI / 180);
  return {
    x: -r * Math.sin(phi) * Math.cos(theta),
    y: r * Math.cos(phi),
    z: r * Math.sin(phi) * Math.sin(theta),
  };
}

export function HeroGlobe() {
  const ref = useRef<HTMLDivElement | null>(null);
  const rx = useMotionValue(0);
  const ry = useMotionValue(0);
  const sx = useSpring(rx, { stiffness: 60, damping: 18 });
  const sy = useSpring(ry, { stiffness: 60, damping: 18 });

  useEffect(() => {
    function onMove(e: PointerEvent) {
      if (!ref.current) return;
      const r = ref.current.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const nx = (e.clientX - cx) / r.width;
      const ny = (e.clientY - cy) / r.height;
      ry.set(Math.max(-1, Math.min(1, nx)) * 14);
      rx.set(Math.max(-1, Math.min(1, ny)) * -8);
    }
    function onLeave() {
      rx.set(0);
      ry.set(0);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerleave', onLeave);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerleave', onLeave);
    };
  }, [rx, ry]);

  const tiltX = useTransform(sx, (v) => `${v}deg`);
  const tiltY = useTransform(sy, (v) => `${v}deg`);

  return (
    <div
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-10 flex items-center justify-center"
      style={{ perspective: 1400 }}
    >
      <motion.div
        style={{
          rotateX: tiltX,
          rotateY: tiltY,
          transformStyle: 'preserve-3d',
        }}
        className="relative h-[520px] w-[520px] sm:h-[600px] sm:w-[600px]"
      >
        {/* Continuously rotating globe core */}
        <motion.div
          animate={{ rotateY: 360 }}
          transition={{ duration: 60, repeat: Infinity, ease: 'linear' }}
          style={{ transformStyle: 'preserve-3d' }}
          className="absolute inset-0"
        >
          {/* Ambient sphere shadow */}
          <div className="absolute inset-0 flex items-center justify-center">
            <div
              className="rounded-full bg-gradient-to-br from-signal/[0.06] to-transparent"
              style={{
                width: RADIUS * 2,
                height: RADIUS * 2,
                boxShadow:
                  'inset 0 0 80px rgba(245,197,24,0.10), inset 30px 0 100px rgba(0,0,0,0.6)',
              }}
            />
          </div>

          {/* Longitude rings — 8 of them, evenly spaced around Y */}
          {Array.from({ length: 8 }).map((_, i) => (
            <Ring
              key={`lng-${i}`}
              rotateY={(i * 180) / 8}
              radius={RADIUS}
              opacity={0.22}
            />
          ))}

          {/* Latitude rings — 5 horizontal ellipses */}
          {[-60, -30, 0, 30, 60].map((lat, i) => (
            <LatRing
              key={`lat-${i}`}
              lat={lat}
              radius={RADIUS}
              emphasis={lat === 0}
            />
          ))}

          {/* Killzone markers */}
          {KILLZONES.map((m, i) => (
            <Marker key={m.city} marker={m} delay={i * 0.4} />
          ))}
        </motion.div>
      </motion.div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────── */

function Ring({
  rotateY,
  radius,
  opacity,
}: {
  rotateY: number;
  radius: number;
  opacity: number;
}) {
  return (
    <div
      className="absolute left-1/2 top-1/2"
      style={{
        width: 0,
        height: 0,
        transform: `translate(-50%,-50%) rotateY(${rotateY}deg)`,
        transformStyle: 'preserve-3d',
      }}
    >
      <div
        className="rounded-full border"
        style={{
          width: radius * 2,
          height: radius * 2,
          borderColor: `hsl(48 95% 55% / ${opacity})`,
          transform: `translate(-50%,-50%)`,
          position: 'absolute',
          left: 0,
          top: 0,
        }}
      />
    </div>
  );
}

function LatRing({
  lat,
  radius,
  emphasis,
}: {
  lat: number;
  radius: number;
  emphasis: boolean;
}) {
  const r = Math.cos((lat * Math.PI) / 180) * radius;
  const y = Math.sin((lat * Math.PI) / 180) * radius;
  const stroke = emphasis ? 'hsl(48 100% 60% / 0.45)' : 'hsl(48 95% 55% / 0.18)';
  const dash = emphasis ? '6 4' : '2 4';

  return (
    <div
      className="absolute left-1/2 top-1/2"
      style={{
        transform: `translate(-50%,-50%) translate3d(0,${y}px,0) rotateX(90deg)`,
        transformStyle: 'preserve-3d',
      }}
    >
      <svg
        width={r * 2 + 4}
        height={r * 2 + 4}
        viewBox={`-${r + 2} -${r + 2} ${r * 2 + 4} ${r * 2 + 4}`}
      >
        <circle
          cx="0"
          cy="0"
          r={r}
          fill="none"
          stroke={stroke}
          strokeWidth={emphasis ? 0.9 : 0.6}
          strokeDasharray={dash}
        />
      </svg>
    </div>
  );
}

function Marker({ marker, delay }: { marker: Marker; delay: number }) {
  const p = project(marker.lat, marker.lon, RADIUS);
  return (
    <div
      className="absolute left-1/2 top-1/2"
      style={{
        transform: `translate(-50%,-50%) translate3d(${p.x}px, ${-p.y}px, ${p.z}px)`,
        transformStyle: 'preserve-3d',
      }}
    >
      {/* Outer pulse */}
      <motion.div
        animate={{ scale: [1, 2.2, 1], opacity: [0.7, 0, 0.7] }}
        transition={{
          duration: 2.6,
          repeat: Infinity,
          ease: 'easeOut',
          delay,
        }}
        className="absolute left-1/2 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-signal"
      />
      {/* Solid core */}
      <div className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-signal shadow-[0_0_12px_rgba(245,197,24,0.9)]" />
      {/* Tag */}
      <span
        className="absolute left-3 top-1/2 -translate-y-1/2 whitespace-nowrap font-mono text-[8px] uppercase tracking-[0.22em] text-signal/80"
        style={{ textShadow: '0 0 6px rgba(0,0,0,0.6)' }}
      >
        {marker.city}
      </span>
    </div>
  );
}
