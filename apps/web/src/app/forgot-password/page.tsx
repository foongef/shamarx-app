'use client';

import { useState } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'motion/react';
import { ArrowRight, Mail, ArrowLeft, CheckCircle2 } from 'lucide-react';
import { api } from '@/lib/api-client';
import { AuthShell } from '@/components/auth/auth-shell';
import { KeyIllustration } from '@/components/auth/key-illustration';

const EASE = [0.16, 1, 0.3, 1] as const;

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

  const variant = submitted ? 'success' : submitting ? 'sending' : 'idle';

  return (
    <AuthShell step={submitted ? 2 : 1}>
      <AnimatePresence mode="wait">
        {!submitted ? (
          <motion.div
            key="form"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.5, ease: EASE }}
          >
            <div className="mb-8 flex items-start gap-5">
              <div className="rounded-md border border-border bg-card/40 p-2.5 backdrop-blur-sm">
                <KeyIllustration variant={variant} />
              </div>
              <div>
                <h1 className="display-serif text-[34px] font-semibold leading-[1.05] tracking-[0.02em] sm:text-[40px]">
                  Forgot your <span className="text-signal">key</span>?
                </h1>
                <p className="mt-2 max-w-md text-[14px] leading-relaxed text-muted-foreground">
                  Enter the email associated with your terminal. We&rsquo;ll send a
                  signed reset link.
                </p>
              </div>
            </div>

            <form onSubmit={onSubmit} className="space-y-5">
              <div>
                <label
                  htmlFor="email"
                  className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground"
                >
                  <Mail className="h-3 w-3 text-signal" strokeWidth={2.4} />
                  Email
                </label>
                <div className="group relative">
                  <input
                    id="email"
                    type="email"
                    required
                    autoFocus
                    autoComplete="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full rounded-md border border-border bg-card/60 px-4 py-3 pr-10 font-mono text-[13px] text-foreground placeholder:text-subtle outline-none transition focus:border-signal/50 focus:bg-background"
                  />
                  <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 font-mono text-[10px] uppercase tracking-[0.22em] text-subtle transition-colors group-focus-within:text-signal">
                    {email.includes('@') ? '✓' : '·'}
                  </span>
                </div>
              </div>

              <button
                type="submit"
                disabled={submitting || !email}
                className="group relative flex w-full items-center justify-center gap-2 overflow-hidden rounded-md bg-signal py-3 font-mono text-[12px] font-semibold uppercase tracking-[0.22em] text-signal-foreground transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span>{submitting ? 'Sending…' : 'Send reset link'}</span>
                <ArrowRight
                  className={`h-4 w-4 transition-transform ${
                    submitting ? 'animate-pulse' : 'group-hover:translate-x-0.5'
                  }`}
                />
              </button>

              <div className="flex items-center justify-between pt-3">
                <Link
                  href="/login"
                  className="group inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground transition-colors hover:text-foreground"
                >
                  <ArrowLeft className="h-3 w-3 transition-transform group-hover:-translate-x-0.5" />
                  Back to sign in
                </Link>
                <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-subtle">
                  Link expires in 1h
                </span>
              </div>
            </form>
          </motion.div>
        ) : (
          <motion.div
            key="success"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.6, ease: EASE }}
          >
            <div className="mb-8 flex items-start gap-5">
              <div className="rounded-md border border-signal/30 bg-signal/[0.06] p-2.5 backdrop-blur-sm">
                <KeyIllustration variant="success" />
              </div>
              <div>
                <h1 className="display-serif text-[34px] font-semibold leading-[1.05] tracking-[0.02em] sm:text-[40px]">
                  Check your <span className="text-signal">inbox</span>.
                </h1>
                <p className="mt-2 max-w-md text-[14px] leading-relaxed text-muted-foreground">
                  If an account exists for{' '}
                  <span className="font-mono text-foreground">{email}</span>, a reset
                  link is on its way.
                </p>
              </div>
            </div>

            <motion.div
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.5, delay: 0.2, ease: EASE }}
              className="rounded-md border border-signal/25 bg-signal/[0.05] p-5 backdrop-blur-sm"
            >
              <div className="flex items-center gap-2.5">
                <CheckCircle2 className="h-4 w-4 text-signal" strokeWidth={2} />
                <span className="font-mono text-[10.5px] uppercase tracking-[0.22em] text-signal">
                  Reset link sent
                </span>
              </div>
              <ul className="mt-4 space-y-2.5 text-[13px] leading-relaxed text-muted-foreground">
                <li className="flex items-start gap-2.5">
                  <span className="mt-2 h-px w-3 shrink-0 bg-signal/60" />
                  <span>
                    Open your inbox and look for an email from{' '}
                    <span className="text-foreground">ShamarX</span>.
                  </span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="mt-2 h-px w-3 shrink-0 bg-signal/60" />
                  <span>The link is single-use and expires in 1 hour.</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="mt-2 h-px w-3 shrink-0 bg-signal/60" />
                  <span>
                    Not seeing it? Check spam, or{' '}
                    <button
                      onClick={() => setSubmitted(false)}
                      className="text-signal underline-offset-4 hover:underline"
                    >
                      try a different email
                    </button>
                    .
                  </span>
                </li>
              </ul>
            </motion.div>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Link
                href="/login"
                className="group inline-flex items-center gap-2 rounded-md border border-border bg-card px-5 py-2.5 font-mono text-[11px] uppercase tracking-[0.22em] text-foreground transition hover:border-border-strong hover:bg-card/80"
              >
                <ArrowLeft className="h-3 w-3 transition-transform group-hover:-translate-x-0.5" />
                Back to sign in
              </Link>
              <button
                onClick={() => setSubmitted(false)}
                className="font-mono text-[11px] uppercase tracking-[0.22em] text-muted-foreground transition-colors hover:text-foreground"
              >
                Resend
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </AuthShell>
  );
}
