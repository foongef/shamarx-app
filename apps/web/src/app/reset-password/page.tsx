'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api-client';

type ValidationState =
  | { status: 'validating' }
  | { status: 'invalid'; reason: string }
  | { status: 'valid' }
  | { status: 'submitted' };

function reasonText(reason: string): string {
  switch (reason) {
    case 'expired':
      return 'This reset link has expired. Request a new one to continue.';
    case 'used':
      return 'This reset link has already been used. Request a new one if you still need to reset.';
    case 'not_found':
      return 'This reset link is invalid. It may have been mistyped or already replaced by a newer one.';
    case 'missing':
      return 'No reset token was provided.';
    default:
      return 'This reset link is no longer valid.';
  }
}

function ResetPasswordInner() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get('token') ?? '';

  const [state, setState] = useState<ValidationState>({ status: 'validating' });
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!token) {
      setState({ status: 'invalid', reason: 'missing' });
      return;
    }
    api
      .validateResetToken(token)
      .then((res) => {
        if (res.valid) setState({ status: 'valid' });
        else setState({ status: 'invalid', reason: res.reason ?? 'unknown' });
      })
      .catch(() => setState({ status: 'invalid', reason: 'unknown' }));
  }, [token]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      await api.resetPassword(token, password);
      setState({ status: 'submitted' });
      setTimeout(() => router.push('/login'), 2500);
    } catch {
      setError('Failed to reset password. The link may have just expired.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="font-serif text-3xl tracking-tight">Set new password</h1>
        </div>

        {state.status === 'validating' && (
          <p className="text-center text-sm text-muted-foreground">Verifying link…</p>
        )}

        {state.status === 'invalid' && (
          <div className="space-y-4">
            <div className="rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              {reasonText(state.reason)}
            </div>
            <Link
              href="/forgot-password"
              className="block rounded-md bg-primary py-2.5 text-center text-sm font-medium text-primary-foreground transition hover:opacity-90"
            >
              Request a new link
            </Link>
          </div>
        )}

        {state.status === 'submitted' && (
          <div className="rounded-md border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm text-green-300">
            Password updated. Redirecting to sign-in…
          </div>
        )}

        {state.status === 'valid' && (
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <label className="mb-1.5 block font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                New password
              </label>
              <input
                type="password"
                required
                autoFocus
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none transition focus:border-primary"
              />
            </div>
            <div>
              <label className="mb-1.5 block font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                Confirm password
              </label>
              <input
                type="password"
                required
                minLength={8}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none transition focus:border-primary"
              />
            </div>

            {error && (
              <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-md bg-primary py-2.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
            >
              {submitting ? 'Saving…' : 'Set new password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div className="p-8 text-center text-sm text-muted-foreground">Loading…</div>}>
      <ResetPasswordInner />
    </Suspense>
  );
}
