'use client';

import { motion } from 'motion/react';

const PAIRS = [
  { sym: 'XAUUSD', label: 'Gold', tone: 'text-signal' },
  { sym: 'EURUSD', label: 'Euro', tone: 'text-foreground' },
  { sym: 'GBPUSD', label: 'Cable', tone: 'text-foreground' },
  { sym: 'USDJPY', label: 'Yen', tone: 'text-foreground' },
];

const SPECS = [
  { label: 'Engine', value: 'V6-alt SMC' },
  { label: 'Entry', value: 'Sweep + structure shift' },
  { label: 'Risk model', value: 'DD-adaptive sizing' },
  { label: 'Time-in-trade', value: 'Killzone-gated' },
  { label: 'Filters', value: 'ADX · ATR · News blackout' },
  { label: 'Exit', value: 'Anchored SL · R-multiple TP' },
];

// Synthetic equity arc — drawn purely visually as a brand element.
const ARC = [
  { x: 0, y: 86 },
  { x: 60, y: 84 },
  { x: 120, y: 78 },
  { x: 180, y: 80 },
  { x: 240, y: 70 },
  { x: 300, y: 72 },
  { x: 360, y: 60 },
  { x: 420, y: 56 },
  { x: 480, y: 58 },
  { x: 540, y: 44 },
  { x: 600, y: 36 },
  { x: 660, y: 38 },
  { x: 720, y: 26 },
  { x: 780, y: 18 },
  { x: 840, y: 22 },
  { x: 900, y: 12 },
];

function buildPath(points: { x: number; y: number }[]) {
  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`)
    .join(' ');
}

export function StrategySpotlight() {
  const pathD = buildPath(ARC);
  const areaD = `${pathD} L900,100 L0,100 Z`;

  return (
    <section
      id="strategy"
      aria-label="Strategy"
      className="relative scroll-mt-24 overflow-hidden border-t border-border/60 bg-card/40 py-24 sm:py-32"
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-signal/40 to-transparent" />

      <div className="mx-auto grid max-w-[1400px] grid-cols-12 gap-x-6 gap-y-12 px-5 sm:px-8 lg:px-12">
        {/* ─── Copy ─────────────────────────────────────────────── */}
        <div className="col-span-12 lg:col-span-5">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          >
            <span className="shamarx-chip">Inside the engine</span>
            <h2 className="mt-4 display-serif text-[34px] font-semibold leading-[1.05] tracking-[0.02em] sm:text-[42px] lg:text-[48px]">
              An SMC engine,
              <br />
              <span className="text-signal">forged</span> in backtest.
            </h2>
            <p className="mt-5 max-w-md text-[15px] leading-relaxed text-muted-foreground">
              ShamarX runs a Smart Money Concept strategy validated across years of
              real Dukascopy data. Sweep + structure shift, anchored to multi-timeframe
              context, with risk model and kill-switch baked in.
            </p>
          </motion.div>

          <motion.dl
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.7, delay: 0.15, ease: [0.16, 1, 0.3, 1] }}
            className="mt-9 grid grid-cols-2 gap-x-8 gap-y-5"
          >
            {SPECS.map((s) => (
              <div key={s.label} className="border-l border-border pl-3">
                <dt className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                  {s.label}
                </dt>
                <dd className="mt-1 font-mono text-[12.5px] tracking-wide text-foreground">
                  {s.value}
                </dd>
              </div>
            ))}
          </motion.dl>
        </div>

        {/* ─── Equity arc panel ──────────────────────────────────── */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-100px' }}
          transition={{ duration: 0.8, delay: 0.2, ease: [0.16, 1, 0.3, 1] }}
          className="col-span-12 lg:col-span-7"
        >
          <div className="relative overflow-hidden rounded-md border border-border bg-background/60 p-6 backdrop-blur-sm sm:p-8">
            <div className="flex items-baseline justify-between gap-3">
              <div>
                <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
                  Backtest · 4 years · 4 pairs
                </span>
                <div className="mt-2 flex items-baseline gap-3">
                  <span className="display-serif text-[36px] font-semibold leading-none tracking-[0.02em] sm:text-[44px]">
                    +530<span className="text-signal">%</span>
                  </span>
                  <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
                    cumulative · risk-managed
                  </span>
                </div>
              </div>
              <div className="hidden text-right sm:block">
                <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
                  Engine
                </span>
                <div className="mt-1 font-mono text-[12px] text-foreground">V6-alt</div>
              </div>
            </div>

            {/* Equity SVG */}
            <div className="mt-7">
              <svg
                viewBox="0 0 900 100"
                preserveAspectRatio="none"
                className="h-44 w-full sm:h-56"
                aria-hidden
              >
                <defs>
                  <linearGradient id="arc-fill" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor="hsl(48 100% 60%)" stopOpacity="0.45" />
                    <stop offset="100%" stopColor="hsl(48 100% 60%)" stopOpacity="0" />
                  </linearGradient>
                  <linearGradient id="arc-line" x1="0" x2="1" y1="0" y2="0">
                    <stop offset="0%" stopColor="hsl(48 95% 55% / 0.3)" />
                    <stop offset="60%" stopColor="hsl(48 100% 60%)" />
                    <stop offset="100%" stopColor="hsl(50 100% 70%)" />
                  </linearGradient>
                </defs>
                {/* grid */}
                {[20, 40, 60, 80].map((y) => (
                  <line
                    key={y}
                    x1="0"
                    x2="900"
                    y1={y}
                    y2={y}
                    stroke="currentColor"
                    strokeWidth="0.5"
                    className="text-border"
                  />
                ))}
                <motion.path
                  d={areaD}
                  fill="url(#arc-fill)"
                  initial={{ opacity: 0 }}
                  whileInView={{ opacity: 1 }}
                  viewport={{ once: true }}
                  transition={{ duration: 1.2, delay: 0.4 }}
                />
                <motion.path
                  d={pathD}
                  fill="none"
                  stroke="url(#arc-line)"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  initial={{ pathLength: 0 }}
                  whileInView={{ pathLength: 1 }}
                  viewport={{ once: true }}
                  transition={{ duration: 2, delay: 0.3, ease: [0.4, 0, 0.2, 1] }}
                />
                {/* End cap dot */}
                <motion.circle
                  cx={ARC[ARC.length - 1].x}
                  cy={ARC[ARC.length - 1].y}
                  r="3"
                  fill="hsl(48 100% 60%)"
                  initial={{ scale: 0 }}
                  whileInView={{ scale: [0, 1.5, 1] }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.6, delay: 2.1 }}
                />
              </svg>
            </div>

            {/* Pair chips */}
            <div className="mt-6 flex flex-wrap gap-2">
              {PAIRS.map((p) => (
                <span
                  key={p.sym}
                  className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 font-mono text-[11px] tracking-wide"
                >
                  <span className={p.tone}>●</span>
                  <span className="text-foreground">{p.sym}</span>
                  <span className="text-muted-foreground">/ {p.label}</span>
                </span>
              ))}
            </div>

            <p className="mt-5 max-w-2xl text-[12px] leading-relaxed text-muted-foreground">
              Past performance from backtests does not guarantee future results.
              ShamarX is a tool — discipline still belongs to the operator.
            </p>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
