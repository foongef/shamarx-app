'use client';

import Link from 'next/link';
import { motion, type Variants, useMotionValue, useSpring, useTransform } from 'motion/react';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import { ShamarxLogo } from '@/components/brand/shamarx-logo';
import { GradientMesh } from './gradient-mesh';
import { Lattice } from './lattice';
import { AnimatedHeadline } from './animated-headline';
import { TapeStrip } from './tape-strip';
import { HeroGlobe } from './hero-globe';
import { useEffect, useRef } from 'react';

const EASE = [0.16, 1, 0.3, 1] as const;

const fadeUp: Variants = {
  hidden: { opacity: 0, y: 24 },
  visible: (i: number = 0) => ({
    opacity: 1,
    y: 0,
    transition: { delay: 1.0 + i * 0.1, duration: 0.7, ease: EASE },
  }),
};

export function LandingHero() {
  const monolithRef = useRef<HTMLDivElement | null>(null);

  const rx = useMotionValue(0);
  const ry = useMotionValue(0);
  const sx = useSpring(rx, { stiffness: 80, damping: 18 });
  const sy = useSpring(ry, { stiffness: 80, damping: 18 });

  useEffect(() => {
    function onPointerMove(e: PointerEvent) {
      if (!monolithRef.current) return;
      const rect = monolithRef.current.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const nx = (e.clientX - cx) / rect.width;
      const ny = (e.clientY - cy) / rect.height;
      ry.set(Math.max(-1, Math.min(1, nx)) * 8);
      rx.set(Math.max(-1, Math.min(1, ny)) * -8);
    }
    function onLeave() {
      rx.set(0);
      ry.set(0);
    }
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerleave', onLeave);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerleave', onLeave);
    };
  }, [rx, ry]);

  const tiltX = useTransform(sx, (v) => `${v}deg`);
  const tiltY = useTransform(sy, (v) => `${v}deg`);

  return (
    <section
      className="relative isolate flex min-h-[100svh] items-center overflow-hidden pt-32 sm:pt-36"
      aria-label="Shamarx — Disciplined trading system"
    >
      {/* Layered atmosphere — toned down, 3D scene takes the spotlight */}
      <GradientMesh />
      <Lattice className="opacity-[0.35]" />

      {/* Drifting tape strips — far/near, opposing directions */}
      <TapeStrip className="top-[26%]" speed={75} />
      <TapeStrip className="top-[68%]" speed={55} reverse />

      {/* Glow rails */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-signal/40 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-signal/10 to-transparent" />

      <div className="relative z-10 mx-auto grid w-full max-w-[1400px] grid-cols-12 gap-x-6 gap-y-14 px-5 pb-24 pt-8 sm:px-8 lg:px-12 lg:pb-32 lg:pt-16">
        {/* ─── Copy ─────────────────────────────────────────────────── */}
        <div className="col-span-12 flex flex-col gap-7 lg:col-span-7">
          {/* Animated chip */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: EASE }}
            className="inline-flex w-fit items-center gap-2 rounded-full border border-signal/30 bg-signal/[0.06] px-3.5 py-1.5"
          >
            <ShieldCheck className="h-3.5 w-3.5 text-signal" strokeWidth={2.4} />
            <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-signal">
              Guarded by Design
            </span>
            <span className="ml-0.5 inline-block h-3 w-px animate-pulse bg-signal/80" />
          </motion.div>

          {/* Animated kinetic headline (Orbitron) */}
          <AnimatedHeadline />

          <motion.p
            variants={fadeUp}
            initial="hidden"
            animate="visible"
            custom={0}
            className="max-w-xl text-[15px] leading-relaxed text-muted-foreground sm:text-[16px]"
          >
            ShamarX is an intelligent trading system that monitors markets, manages risk,
            and executes with precision — built for traders who value{' '}
            <span className="text-foreground">consistency</span> over hype.
          </motion.p>

          <motion.div
            variants={fadeUp}
            initial="hidden"
            animate="visible"
            custom={1}
            className="flex flex-wrap items-center gap-3"
          >
            <Link
              href="/login"
              className="group relative inline-flex items-center gap-2 overflow-hidden rounded-md bg-signal px-6 py-3.5 font-mono text-[12px] font-semibold uppercase tracking-[0.22em] text-signal-foreground transition"
            >
              <span className="relative z-10">Get Started</span>
              <ArrowRight className="relative z-10 h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              <span className="absolute inset-0 -z-0 bg-[radial-gradient(ellipse_at_center,_color-mix(in_oklab,_var(--signal-foreground)_22%,_transparent),_transparent_60%)] opacity-0 transition-opacity group-hover:opacity-100" />
            </Link>

            <a
              href="#strategy"
              className="group inline-flex items-center gap-2 rounded-md border border-border bg-card/40 px-6 py-3.5 font-mono text-[12px] uppercase tracking-[0.22em] text-foreground backdrop-blur-sm transition hover:border-border-strong hover:bg-card/80"
            >
              View Strategy
              <span className="font-mono text-[10px] text-muted-foreground transition-colors group-hover:text-signal">
                ↓
              </span>
            </a>
          </motion.div>

          <motion.dl
            variants={fadeUp}
            initial="hidden"
            animate="visible"
            custom={2}
            className="mt-5 grid max-w-lg grid-cols-3 gap-px overflow-hidden rounded-md border border-border bg-border"
          >
            {[
              { v: '24 / 7', l: 'Monitoring' },
              { v: '1.5%', l: 'Per-trade risk' },
              { v: '4', l: 'Pairs tracked' },
            ].map((s) => (
              <div key={s.l} className="bg-card/60 px-4 py-3.5 backdrop-blur-sm">
                <dt className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-muted-foreground">
                  {s.l}
                </dt>
                <dd className="display-serif mt-1 text-[18px] font-semibold leading-none text-foreground sm:text-[22px]">
                  {s.v}
                </dd>
              </div>
            ))}
          </motion.dl>
        </div>

        {/* ─── 3D scene + logo monolith ─────────────────────────────── */}
        <div className="relative col-span-12 flex h-[480px] items-center justify-center sm:h-[560px] lg:col-span-5">
          {/* 3D wireframe globe with FX killzone markers, behind the logo */}
          <HeroGlobe />

          {/* Subtle ambient halo — far softer than before */}
          <motion.div
            aria-hidden
            animate={{ scale: [1, 1.04, 1], opacity: [0.16, 0.28, 0.16] }}
            transition={{ duration: 7, repeat: Infinity, ease: 'easeInOut' }}
            className="pointer-events-none absolute inset-0 -z-10 rounded-full bg-signal/[0.08] blur-[60px]"
          />

          <motion.div
            ref={monolithRef}
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 1.0, delay: 0.4, ease: EASE }}
            style={{
              rotateX: tiltX,
              rotateY: tiltY,
              transformStyle: 'preserve-3d',
              perspective: 1000,
            }}
            className="relative"
          >
            <ShamarxLogo
              variant="vertical"
              height={300}
              priority
              className="drop-shadow-[0_0_28px_rgba(245,197,24,0.22)]"
            />
          </motion.div>
        </div>
      </div>

      {/* Scroll cue */}
      <motion.a
        href="#trust"
        aria-hidden
        animate={{ y: [0, 8, 0] }}
        transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}
        className="absolute bottom-6 left-1/2 z-10 -translate-x-1/2 font-mono text-[10px] uppercase tracking-[0.32em] text-muted-foreground/60"
      >
        scroll
      </motion.a>
    </section>
  );
}
