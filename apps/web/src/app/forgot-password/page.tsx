'use client';

import { useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api-client';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await api.forgotPassword(email);
      setSubmitted(true);
    } catch {
      // We always claim success to avoid disclosing whether the email exists.
      setSubmitted(true);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="font-serif text-3xl tracking-tight">Forgot password</h1>
          <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            We&apos;ll email you a reset link
          </p>
        </div>

        {submitted ? (
          <div className="space-y-4">
            <div className="rounded-md border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm text-green-300">
              If an account exists for <span className="font-mono">{email}</span>, a reset link has
              been sent. Check your inbox (and spam folder).
            </div>
            <p className="text-center font-mono text-[11px] tracking-widest text-muted-foreground">
              The link expires in 1 hour.
            </p>
            <Link
              href="/login"
              className="block rounded-md border border-border py-2.5 text-center text-sm transition hover:bg-muted"
            >
              Back to sign in
            </Link>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <label className="mb-1.5 block font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                Email
              </label>
              <input
                type="email"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none transition focus:border-primary"
              />
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-md bg-primary py-2.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
            >
              {submitting ? 'Sending…' : 'Send reset link'}
            </button>

            <div className="pt-2 text-center">
              <Link
                href="/login"
                className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
              >
                ← Back to sign in
              </Link>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
