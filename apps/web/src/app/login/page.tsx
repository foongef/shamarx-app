'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { CandlestickChart } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { ApiError } from '@/lib/api-client';

export default function LoginPage() {
  const { user, login } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (user) router.replace('/');
  }, [user, router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError('Invalid email or password.');
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center px-6">
      {/* Atmospheric backdrop */}
      <div className="absolute inset-0 grid-pattern opacity-25" />
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-signal/30 to-transparent" />

      <div className="relative w-full max-w-[400px]">
        {/* Brand mark */}
        <div className="mb-10 flex flex-col items-center gap-2">
          <CandlestickChart className="h-5 w-5 text-signal" strokeWidth={1.75} />
          <span className="display-serif text-[42px] leading-none tracking-tight">
            Tape
          </span>
          <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
            v0.6 · invite-only terminal
          </span>
        </div>

        {/* Editorial divider */}
        <div className="mb-8 flex items-center gap-3">
          <div className="h-px flex-1 bg-border" />
          <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-subtle">
            Sign in
          </span>
          <div className="h-px flex-1 bg-border" />
        </div>

        <form onSubmit={onSubmit} className="space-y-5">
          <div>
            <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Email
            </label>
            <input
              type="email"
              required
              autoFocus
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md border border-border bg-card px-3 py-2.5 font-mono text-[13px] text-foreground outline-none transition focus:border-signal/50 focus:bg-background"
            />
          </div>
          <div>
            <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Password
            </label>
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-border bg-card px-3 py-2.5 font-mono text-[13px] text-foreground outline-none transition focus:border-signal/50 focus:bg-background"
            />
          </div>

          {error && (
            <div className="rounded-md border border-loss/30 bg-loss/10 px-3 py-2 font-mono text-[11px] text-loss">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="group relative w-full overflow-hidden rounded-md bg-signal py-2.5 font-mono text-[12px] font-medium uppercase tracking-[0.18em] text-signal-foreground transition disabled:opacity-60"
          >
            {submitting ? 'Authorising…' : 'Sign in →'}
          </button>

          <div className="pt-1 text-center">
            <Link
              href="/forgot-password"
              className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground transition hover:text-foreground"
            >
              Forgot password?
            </Link>
          </div>
        </form>

        <div className="mt-12 text-center font-mono text-[9px] uppercase tracking-[0.22em] text-subtle">
          Phase 1 · Solo · No public signup
        </div>
      </div>
    </div>
  );
}
