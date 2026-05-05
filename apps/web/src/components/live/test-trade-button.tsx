'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDownRight, ArrowUpRight, FlaskConical } from 'lucide-react';
import { api } from '@/lib/api-client';
import { cn } from '@/lib/utils';

const PAIRS = ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY'];

export function TestTradeButton() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [symbol, setSymbol] = useState('EURUSD');
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [lotSize, setLotSize] = useState(0.01);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: () => api.liveTestTrade({ symbol, side, lotSize }),
    onSuccess: (data) => {
      setResult(data.signal.reason);
      setError(null);
      qc.invalidateQueries();
    },
    onError: (e) => {
      setError((e as Error).message);
      setResult(null);
    },
  });

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-md border border-warning/30 bg-warning/10 px-2.5 py-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-warning transition hover:bg-warning/15"
        title="Fire a synthetic test trade — bypasses SMC selectivity"
      >
        <FlaskConical className="h-3 w-3" />
        <span>Test trade</span>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
          <div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={() => !mut.isPending && setOpen(false)}
          />
          <div className="relative w-full max-w-md overflow-hidden rounded-lg border border-yellow-500/30 bg-background shadow-2xl">
            <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
              <div>
                <h2 className="font-serif text-lg tracking-tight">Fire test trade</h2>
                <p className="text-[11px] text-muted-foreground">
                  Bypasses SMC evaluator. Verifies broker connection + DB persistence.
                </p>
              </div>
            </div>

            <div className="space-y-4 px-5 py-5">
              <div>
                <label className="mb-1.5 block font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                  Pair
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {PAIRS.map((p) => (
                    <button
                      key={p}
                      onClick={() => setSymbol(p)}
                      className={cn(
                        'rounded-md border px-3 py-1.5 font-mono text-[12px] transition',
                        symbol === p
                          ? 'border-yellow-500/50 bg-yellow-500/10 text-foreground'
                          : 'border-border text-muted-foreground hover:border-yellow-500/30',
                      )}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="mb-1.5 block font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                  Side
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setSide('BUY')}
                    className={cn(
                      'flex items-center justify-center gap-2 rounded-md border px-3 py-2 transition',
                      side === 'BUY'
                        ? 'border-green-500/50 bg-green-500/10 text-green-400'
                        : 'border-border text-muted-foreground hover:border-green-500/30',
                    )}
                  >
                    <ArrowUpRight className="h-4 w-4" /> BUY
                  </button>
                  <button
                    onClick={() => setSide('SELL')}
                    className={cn(
                      'flex items-center justify-center gap-2 rounded-md border px-3 py-2 transition',
                      side === 'SELL'
                        ? 'border-red-500/50 bg-red-500/10 text-red-400'
                        : 'border-border text-muted-foreground hover:border-red-500/30',
                    )}
                  >
                    <ArrowDownRight className="h-4 w-4" /> SELL
                  </button>
                </div>
              </div>

              <div>
                <label className="mb-1.5 block font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                  Lot size · {lotSize.toFixed(2)}
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {[0.01, 0.05, 0.1].map((l) => (
                    <button
                      key={l}
                      onClick={() => setLotSize(l)}
                      className={cn(
                        'rounded-md border px-3 py-1.5 font-mono text-[12px] transition',
                        lotSize === l
                          ? 'border-primary bg-primary/15'
                          : 'border-border text-muted-foreground hover:border-primary/50',
                      )}
                    >
                      {l.toFixed(2)}
                    </button>
                  ))}
                </div>
              </div>

              <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3 text-[11px] text-yellow-200">
                ⚠ This places a REAL order via your live broker (mock or MetaApi). SL/TP are
                derived from current M15 ATR. Only use to verify the pipeline.
              </div>

              {result && (
                <div className="rounded-md border border-green-500/30 bg-green-500/10 p-3 font-mono text-[11px] text-green-200">
                  ✓ {result}
                </div>
              )}
              {error && (
                <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3 font-mono text-[11px] text-red-300">
                  ✗ {error}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-border bg-muted/20 px-5 py-3">
              <button
                onClick={() => !mut.isPending && setOpen(false)}
                className="rounded-md border border-border px-4 py-2 text-sm transition hover:bg-muted"
              >
                Close
              </button>
              <button
                onClick={() => mut.mutate()}
                disabled={mut.isPending}
                className="inline-flex items-center gap-2 rounded-md bg-yellow-500/15 px-4 py-2 text-sm font-medium text-yellow-300 ring-1 ring-inset ring-yellow-500/30 transition hover:bg-yellow-500/25 disabled:opacity-60"
              >
                <FlaskConical className="h-4 w-4" />
                {mut.isPending ? 'Firing…' : `Fire ${side} ${symbol} ${lotSize.toFixed(2)}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
