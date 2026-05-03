'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2, ArrowRight } from 'lucide-react';
import { useCreateBacktest } from '@/hooks/use-create-backtest';
import { StrategyBadge } from './strategy-badge';
import { InfoTip } from './info-tip';
import { STRATEGY_META } from '@/lib/aggregate';
import type { StrategyVersion } from '@/lib/types';
import { cn } from '@/lib/utils';

const SYMBOLS = ['XAUUSD', 'GBPUSD', 'EURUSD', 'USDJPY'] as const;
const ACCOUNTS = [100, 500, 1000, 2000, 10000] as const;
const RISKS = [0.5, 1.0, 1.5, 2.0, 3.0] as const;
const STRATEGIES: StrategyVersion[] = ['V5.5b', 'V6', 'V6-alt'];

const schema = z.object({
  symbol: z.enum(SYMBOLS),
  startDate: z.string().min(1, 'Start date is required'),
  endDate: z.string().min(1, 'End date is required'),
  initialBalance: z.coerce.number().min(100).max(1_000_000),
  riskPercent: z.coerce.number().min(0.1).max(10),
  strategyVersion: z.enum(['V5.5b', 'V6', 'V6-alt']),
  withLlm: z.boolean(),
});

type FormValues = z.infer<typeof schema>;

export function BacktestForm() {
  const { mutate, isPending } = useCreateBacktest();

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      symbol: 'XAUUSD',
      startDate: '2025-01-01',
      endDate: '2025-12-31',
      initialBalance: 1000,
      riskPercent: 1.5,
      strategyVersion: 'V6-alt',
      withLlm: false,
    },
  });

  const symbol = watch('symbol');
  const strategy = watch('strategyVersion');
  const initialBalance = watch('initialBalance');
  const riskPercent = watch('riskPercent');

  function onSubmit(data: FormValues) {
    mutate(data);
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-8">
      {/* Strategy comparison */}
      <section className="flex flex-col gap-3">
        <Eyebrow
          step="01"
          label="Choose Strategy"
          info={
            <InfoTip title="Strategy">
              <p>
                Each version is a different trading approach. They run on the
                <strong> same M15 data</strong> with the same risk manager — only
                the entry/exit logic differs.
              </p>
              <p>
                <strong>V5.5b</strong> — conservative trend pullback. Fires
                rarely, very high win rate when it does.
              </p>
              <p>
                <strong>V6</strong> — adds D1 confluence + 4 extra engines for
                higher trade frequency.
              </p>
              <p>
                <strong>V6-alt</strong> — Smart Money Concepts (sweep + reverse /
                continuation). The strongest performer on real Dukascopy.
              </p>
            </InfoTip>
          }
        />
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          {STRATEGIES.map((s) => {
            const meta = STRATEGY_META[s];
            const active = strategy === s;
            return (
              <button
                key={s}
                type="button"
                onClick={() => setValue('strategyVersion', s)}
                className={cn(
                  'group relative flex flex-col gap-3 border p-4 text-left transition-all',
                  active
                    ? 'border-signal bg-signal/5'
                    : 'border-border bg-card hover:border-border-strong',
                )}
              >
                <div className="flex items-start justify-between">
                  <StrategyBadge version={s} size="md" />
                  <span
                    className={cn(
                      'h-3 w-3 rounded-full border-2 transition-colors',
                      active
                        ? 'border-signal bg-signal'
                        : 'border-border-strong',
                    )}
                  />
                </div>
                <h4
                  className={cn(
                    'display-serif text-[18px] leading-tight tracking-tight',
                    meta.hue,
                  )}
                >
                  {meta.blurb}
                </h4>
                <p className="text-[12px] leading-relaxed text-muted-foreground">
                  {meta.description}
                </p>
                {active && (
                  <span className="pointer-events-none absolute -top-px -right-px h-2 w-8 bg-signal" />
                )}
              </button>
            );
          })}
        </div>
      </section>

      {/* Symbol */}
      <section className="flex flex-col gap-3">
        <Eyebrow
          step="02"
          label="Symbol"
          info={
            <InfoTip title="Symbol">
              <p>
                Which instrument the engine backtests against. Each symbol uses
                its own per-pair tuning ({' '}
                <code>smc/pairs/&lt;symbol&gt;.ts</code>) — sweep buffers,
                killzone hours, ADX thresholds.
              </p>
              <p>
                <strong>XAUUSD</strong> (gold) is the strongest pair for V6-alt.
                <strong>EURUSD</strong> works but with weaker edge. Other pairs
                use scaffold configs and may need tuning.
              </p>
            </InfoTip>
          }
        />
        <div className="flex flex-wrap gap-2">
          {SYMBOLS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setValue('symbol', s)}
              className={cn(
                'flex items-center gap-2 border px-4 py-2 font-mono text-[12px] uppercase tracking-widest transition-colors',
                symbol === s
                  ? 'border-signal bg-signal/10 text-signal'
                  : 'border-border bg-surface text-muted-foreground hover:border-border-strong hover:text-foreground',
              )}
            >
              {s}
            </button>
          ))}
        </div>
      </section>

      {/* Dates */}
      <section className="flex flex-col gap-3">
        <Eyebrow
          step="03"
          label="Period"
          info={
            <InfoTip title="Period">
              <p>
                Date range to backtest. Real Dukascopy data available from
                <strong> 2023-01-01 → 2026-04-30</strong> for XAUUSD &amp; EURUSD.
              </p>
              <p>
                Longer windows give more reliable results. 1+ year is the
                minimum for meaningful Sharpe / PF numbers; sub-monthly windows
                are mostly noise.
              </p>
            </InfoTip>
          }
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Start" error={errors.startDate?.message}>
            <input
              type="date"
              {...register('startDate')}
              className={inputClass}
            />
          </Field>
          <Field label="End" error={errors.endDate?.message}>
            <input
              type="date"
              {...register('endDate')}
              className={inputClass}
            />
          </Field>
        </div>
        <div className="flex flex-wrap gap-2">
          {[
            { label: '2023', start: '2023-01-15', end: '2023-12-31' },
            { label: '2024', start: '2024-01-01', end: '2024-12-31' },
            { label: '2025', start: '2025-01-01', end: '2025-12-31' },
            { label: '2026 YTD', start: '2026-01-01', end: '2026-04-30' },
          ].map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => {
                setValue('startDate', p.start);
                setValue('endDate', p.end);
              }}
              className="border border-border bg-surface px-3 py-1 font-mono text-[10.5px] uppercase tracking-widest text-muted-foreground hover:border-border-strong hover:text-foreground"
            >
              {p.label}
            </button>
          ))}
        </div>
      </section>

      {/* Account & risk */}
      <section className="flex flex-col gap-3">
        <Eyebrow
          step="04"
          label="Account & Risk"
          info={
            <InfoTip title="Account & Risk">
              <p>
                These two numbers determine your <strong>position size</strong>
                {' '}per trade. The engine sizes each trade so a stop-loss costs
                roughly <code>balance × risk%</code>.
              </p>
              <p>
                Smaller accounts (&lt;$1k) hit a hard floor of 0.01 lot, which
                can <strong>over-risk</strong> on wide-SL setups — the engine
                skips those trades to keep you safe.
              </p>
              <p>
                Sweet spot: <strong>$1,000–$2,000 at 1.5%</strong>.
              </p>
            </InfoTip>
          }
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            label="Initial Balance"
            error={errors.initialBalance?.message}
            hint={`$${initialBalance?.toLocaleString?.()}`}
            info={
              <InfoTip title="Initial Balance">
                <p>
                  Account size the backtest simulates. Affects lot sizing and
                  which setups are taken.
                </p>
                <p>
                  <strong>$100</strong> — backtest only. Lot floor (0.01)
                  forces over-risk on most setups; engine skips most. Returns
                  look huge from compounding but won&apos;t replicate live.
                </p>
                <p>
                  <strong>$1,000–$2,000</strong> — sweet spot. Lot sizing
                  matches intended risk; trade selection isn&apos;t accidentally
                  filtered.
                </p>
                <p>
                  <strong>$10,000+</strong> — granular sizing, takes every
                  setup, lower % return but realistic.
                </p>
              </InfoTip>
            }
          >
            <input
              type="number"
              step="100"
              {...register('initialBalance')}
              className={inputClass}
            />
            <div className="flex flex-wrap gap-1.5 pt-2">
              {ACCOUNTS.map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => setValue('initialBalance', a)}
                  className={cn(
                    'border border-border px-2 py-0.5 font-mono text-[10px] tracking-widest',
                    initialBalance === a
                      ? 'border-signal bg-signal/10 text-signal'
                      : 'bg-surface text-muted-foreground hover:border-border-strong',
                  )}
                >
                  ${a.toLocaleString()}
                </button>
              ))}
            </div>
          </Field>
          <Field
            label="Risk % per Trade"
            error={errors.riskPercent?.message}
            hint={`${riskPercent}%`}
            info={
              <InfoTip title="Risk per Trade" side="left">
                <p>
                  How much of your balance you&apos;re willing to lose if the
                  stop-loss hits. The engine sizes each lot to make
                  <code> SL distance × lot = balance × risk%</code>.
                </p>
                <p>
                  An <strong>honest-risk cap</strong> rejects any trade where
                  the lot floor would force the actual risk above
                  <code> 1.10×</code> your setting — this is why a too-small risk
                  can produce zero trades on small accounts.
                </p>
                <p>
                  <strong>1.0%</strong> — conservative; tighter cap, fewer but
                  higher-edge trades.
                </p>
                <p>
                  <strong>1.5%</strong> — recommended for V6-alt. Best
                  risk-adjusted return in our tuning sweep.
                </p>
                <p>
                  <strong>2.0–3.0%</strong> — aggressive. Returns scale roughly
                  linearly, but so does drawdown.
                </p>
              </InfoTip>
            }
          >
            <input
              type="number"
              step="0.1"
              {...register('riskPercent')}
              className={inputClass}
            />
            <div className="flex flex-wrap gap-1.5 pt-2">
              {RISKS.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setValue('riskPercent', r)}
                  className={cn(
                    'border border-border px-2 py-0.5 font-mono text-[10px] tracking-widest',
                    riskPercent === r
                      ? 'border-signal bg-signal/10 text-signal'
                      : 'bg-surface text-muted-foreground hover:border-border-strong',
                  )}
                >
                  {r}%
                </button>
              ))}
            </div>
          </Field>
        </div>
      </section>

      {/* CTA */}
      <div className="flex items-center justify-between gap-4 border-t border-border pt-6">
        <div className="text-[11.5px] text-muted-foreground">
          The run will stream into the library when complete. Most backtests
          finish in <span className="font-mono text-foreground">~1–3s</span>.
        </div>
        <button
          type="submit"
          disabled={isPending}
          className="group flex items-center gap-2 border border-foreground bg-foreground px-5 py-2.5 text-[12.5px] font-medium uppercase tracking-widest text-background transition-colors hover:border-signal hover:bg-signal hover:text-signal-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isPending ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Submitting…
            </>
          ) : (
            <>
              Submit
              <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
            </>
          )}
        </button>
      </div>
    </form>
  );
}

const inputClass =
  'h-10 w-full border border-border bg-surface px-3 font-mono text-[13px] tabular-nums text-foreground placeholder:text-subtle focus:border-signal focus:outline-none';

function Eyebrow({
  step,
  label,
  info,
}: {
  step: string;
  label: string;
  info?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-[10px] tabular-nums text-signal">
        {step}
      </span>
      <span className="label-eyebrow">{label}</span>
      {info}
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function Field({
  label,
  hint,
  error,
  info,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  info?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="flex items-center gap-1.5">
          <span className="label-eyebrow">{label}</span>
          {info}
        </span>
        {hint && (
          <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">
            {hint}
          </span>
        )}
      </div>
      {children}
      {error && (
        <span className="font-mono text-[10.5px] uppercase tracking-widest text-loss">
          {error}
        </span>
      )}
    </div>
  );
}
