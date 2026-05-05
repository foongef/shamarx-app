'use client';

import { useEffect, useState } from 'react';
import { Play, X, Info, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface StartConfig {
  strategyVersion: 'V6-alt';
  riskPercent: number;
  mode: 'mock' | 'metaapi';
  mockBalance?: number;
}

const PRESET_BALANCES = [500, 1_000, 2_000, 10_000];
const RISK_PRESETS = [1.0, 1.5, 2.0];

interface Props {
  open: boolean;
  onClose: () => void;
  onConfirm: (cfg: StartConfig) => Promise<void>;
  defaultMode?: 'mock' | 'metaapi';
  metaApiAvailable?: boolean;
  /** Current mock account balance — shown as info in the dialog. */
  currentMockBalance?: number | null;
}

export function StartLiveDialog({
  open,
  onClose,
  onConfirm,
  defaultMode = 'mock',
  metaApiAvailable = false,
  currentMockBalance = null,
}: Props) {
  const [strategyVersion] = useState<'V6-alt'>('V6-alt');
  const [riskPercent, setRiskPercent] = useState<number>(1.5);
  const [mode, setMode] = useState<'mock' | 'metaapi'>(defaultMode);
  const [resetMock, setResetMock] = useState<boolean>(false);
  const [mockBalance, setMockBalance] = useState<number>(2_000);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setMode(defaultMode);
      setResetMock(false);
      setMockBalance(currentMockBalance ?? 2_000);
      setError(null);
      setSubmitting(false);
    }
  }, [open, defaultMode, currentMockBalance]);

  if (!open) return null;

  async function handleStart() {
    setError(null);
    setSubmitting(true);
    try {
      const cfg: StartConfig = {
        strategyVersion,
        riskPercent,
        mode,
        // Only send mockBalance when user explicitly opted to reset.
        // Otherwise the new session continues with whatever balance the
        // mock account currently has.
        mockBalance: mode === 'mock' && resetMock ? mockBalance : undefined,
      };
      await onConfirm(cfg);
      onClose();
    } catch (err) {
      setError((err as Error).message || 'Failed to start engine');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      {/* backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={() => !submitting && onClose()}
      />
      {/* panel */}
      <div className="relative w-full max-w-lg overflow-hidden rounded-lg border border-border bg-background shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <div>
            <h2 className="font-serif text-lg tracking-tight">Configure live engine</h2>
            <p className="text-[11px] text-muted-foreground">
              Set strategy, risk, and execution mode before starting auto-trading
            </p>
          </div>
          <button
            onClick={() => !submitting && onClose()}
            className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-5 px-5 py-5">
          {/* Strategy */}
          <Field label="Strategy">
            <select
              value={strategyVersion}
              disabled
              className="w-full cursor-not-allowed rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-sm text-foreground"
            >
              <option value="V6-alt">V6-alt SMC (sweep + reversal/continuation)</option>
            </select>
            <Hint>V5.5b and V6 will be added in a later phase.</Hint>
          </Field>

          {/* Risk */}
          <Field label={`Risk per trade · ${riskPercent.toFixed(1)}%`}>
            <div className="flex gap-1.5">
              {RISK_PRESETS.map((r) => (
                <button
                  key={r}
                  onClick={() => setRiskPercent(r)}
                  className={cn(
                    'flex-1 rounded-md border px-3 py-2 font-mono text-[12px] transition',
                    riskPercent === r
                      ? 'border-primary bg-primary/15 text-foreground'
                      : 'border-border text-muted-foreground hover:border-primary/50 hover:text-foreground',
                  )}
                >
                  {r.toFixed(1)}%
                </button>
              ))}
              <input
                type="number"
                step={0.1}
                min={0.25}
                max={4}
                value={riskPercent}
                onChange={(e) => setRiskPercent(Math.max(0.25, Math.min(4, parseFloat(e.target.value) || 1.5)))}
                className="w-24 rounded-md border border-border bg-background px-2.5 py-2 text-center font-mono text-[12px] text-foreground"
              />
            </div>
            <Hint>Recommended: 1.5%. Higher = more PnL volatility, larger drawdowns.</Hint>
          </Field>

          {/* Mode */}
          <Field label="Execution mode">
            <div className="grid grid-cols-2 gap-2">
              <ModeCard
                active={mode === 'mock'}
                onClick={() => setMode('mock')}
                title="Mock"
                badge="DEV"
                description="Synthetic broker. Choose your own starting balance. No real fills."
              />
              <ModeCard
                active={mode === 'metaapi'}
                onClick={() => setMode('metaapi')}
                disabled={!metaApiAvailable}
                title="Live (MetaApi)"
                badge="REAL"
                description={
                  metaApiAvailable
                    ? 'Trades on your connected MetaApi demo/live broker.'
                    : 'Requires MetaApi credentials in .env. Currently unavailable.'
                }
              />
            </div>
          </Field>

          {/* Mock balance handling */}
          {mode === 'mock' && (
            <Field
              label={
                resetMock
                  ? `Reset mock account to · $${mockBalance.toLocaleString()}`
                  : 'Mock account balance'
              }
            >
              <div className="rounded-md border border-border bg-muted/20 px-3 py-2.5 text-[12px]">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Current mock balance</span>
                  <span className="font-mono tabular-nums text-foreground">
                    ${currentMockBalance !== null ? currentMockBalance.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'}
                  </span>
                </div>
                <label className="mt-2.5 flex cursor-pointer items-center gap-2 border-t border-border pt-2.5">
                  <input
                    type="checkbox"
                    checked={resetMock}
                    onChange={(e) => setResetMock(e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-border accent-primary"
                  />
                  <span className="text-muted-foreground">Reset balance + clear positions before starting</span>
                </label>
              </div>

              {resetMock && (
                <div className="mt-2 space-y-1.5">
                  <div className="flex flex-wrap gap-1.5">
                    {PRESET_BALANCES.map((b) => (
                      <button
                        key={b}
                        onClick={() => setMockBalance(b)}
                        className={cn(
                          'rounded-md border px-3 py-2 font-mono text-[12px] transition',
                          mockBalance === b
                            ? 'border-primary bg-primary/15 text-foreground'
                            : 'border-border text-muted-foreground hover:border-primary/50 hover:text-foreground',
                        )}
                      >
                        ${b.toLocaleString()}
                      </button>
                    ))}
                    <input
                      type="number"
                      step={100}
                      min={50}
                      max={1_000_000}
                      value={mockBalance}
                      onChange={(e) =>
                        setMockBalance(
                          Math.max(50, Math.min(1_000_000, parseFloat(e.target.value) || 1000)),
                        )
                      }
                      className="w-32 rounded-md border border-border bg-background px-2.5 py-2 text-center font-mono text-[12px] text-foreground"
                    />
                  </div>
                  <Hint>This will OVERWRITE the mock balance and close any open mock positions.</Hint>
                </div>
              )}

              {!resetMock && (
                <Hint>
                  The new session will continue with the existing mock balance — your wins and losses
                  carry over between sessions.
                </Hint>
              )}
            </Field>
          )}

          {mode === 'metaapi' && (
            <div className="flex gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3 text-[12px] text-yellow-200">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <div>
                The bot will trade on your MetaApi account. If it&apos;s a demo, no real money. Make
                absolutely sure the account ID in <span className="font-mono">.env</span> is the right one.
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border bg-muted/20 px-5 py-3">
          <button
            onClick={() => !submitting && onClose()}
            className="rounded-md border border-border px-4 py-2 text-sm transition hover:bg-muted"
          >
            Cancel
          </button>
          <button
            onClick={handleStart}
            disabled={submitting}
            className="inline-flex items-center gap-2 rounded-md bg-green-500/15 px-4 py-2 text-sm font-medium text-green-400 ring-1 ring-inset ring-green-500/30 transition hover:bg-green-500/25 disabled:opacity-60"
          >
            <Play className="h-4 w-4" />
            {submitting ? 'Starting…' : 'Start engine'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-1.5 flex items-start gap-1.5 text-[11px] text-muted-foreground">
      <Info className="mt-0.5 h-3 w-3 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

function ModeCard({
  active,
  onClick,
  disabled = false,
  title,
  badge,
  description,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  title: string;
  badge: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={cn(
        'group relative cursor-pointer rounded-md border p-3 text-left transition',
        active && !disabled
          ? 'border-primary bg-primary/10'
          : 'border-border hover:border-primary/50',
        disabled && 'cursor-not-allowed opacity-50 hover:border-border',
      )}
    >
      <div className="mb-1 flex items-center justify-between">
        <span className="text-sm font-medium">{title}</span>
        <span
          className={cn(
            'rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest',
            badge === 'DEV' ? 'bg-zinc-500/20 text-zinc-300' : 'bg-amber-500/20 text-amber-300',
          )}
        >
          {badge}
        </span>
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">{description}</p>
    </button>
  );
}
