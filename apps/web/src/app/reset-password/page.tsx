'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { motion, AnimatePresence } from 'motion/react';
import {
  ArrowRight,
  Lock,
  Eye,
  EyeOff,
  AlertCircle,
  CheckCircle2,
  RefreshCcw,
  ArrowLeft,
} from 'lucide-react';
import { api } from '@/lib/api-client';
import { AuthShell } from '@/components/auth/auth-shell';
import { KeyIllustration } from '@/components/auth/key-illustration';

const EASE = [0.16, 1, 0.3, 1] as const;

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

/* ─── Password strength helper ─── */
function strengthOf(password: string): { score: 0 | 1 | 2 | 3 | 4; label: string; tone: string } {
  if (!password) return { score: 0, label: '—', tone: 'text-subtle' };
  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score++;
  if (/\d/.test(password) && /[^A-Za-z0-9]/.test(password)) score++;
  const labels = ['Weak', 'Fair', 'Good', 'Strong', 'Excellent'];
  const tones = [
    'text-loss',
    'text-warning',
    'text-warning',
    'text-signal',
    'text-profit',
  ];
  return {
    score: Math.min(4, score) as 0 | 1 | 2 | 3 | 4,
    label: labels[Math.min(4, score)],
    tone: tones[Math.min(4, score)],
  };
}

function ResetPasswordInner() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get('token') ?? '';

  const [state, setState] = useState<ValidationState>({ status: 'validating' });
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
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
      setTimeout(() => router.push('/login'), 2400);
    } catch {
      setError('Failed to reset password. The link may have just expired.');
    } finally {
      setSubmitting(false);
    }
  }

  const strength = strengthOf(password);
  const matches = password && confirm && password === confirm;

  // Step indicator: Identify(1) — Send(2) — Verify(3)
  const step =
    state.status === 'submitted' ? 3 : state.status === 'valid' ? 3 : 3;
  const variant: 'idle' | 'sending' | 'success' =
    state.status === 'submitted' ? 'success' : submitting ? 'sending' : 'idle';

  return (
    <AuthShell step={step}>
      <AnimatePresence mode="wait">
        {state.status === 'validating' && (
          <motion.div
            key="validating"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex flex-col items-start gap-5"
          >
            <div className="rounded-md border border-border bg-card/40 p-2.5 backdrop-blur-sm">
              <KeyIllustration variant="sending" />
            </div>
            <div>
              <h1 className="display-serif text-[34px] font-semibold leading-[1.05] tracking-[0.02em] sm:text-[40px]">
                Verifying <span className="text-signal">link</span>…
              </h1>
              <p className="mt-2 text-[14px] leading-relaxed text-muted-foreground">
                Hold on while we confirm your reset token is valid.
              </p>
            </div>
          </motion.div>
        )}

        {state.status === 'invalid' && (
          <motion.div
            key="invalid"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5, ease: EASE }}
          >
            <div className="mb-8 flex items-start gap-5">
              <div className="rounded-md border border-loss/30 bg-loss/[0.08] p-2.5 backdrop-blur-sm">
                <KeyIllustration variant="idle" />
              </div>
              <div>
                <h1 className="display-serif text-[34px] font-semibold leading-[1.05] tracking-[0.02em] sm:text-[40px]">
                  Link <span className="text-loss">expired</span>.
                </h1>
                <p className="mt-2 max-w-md text-[14px] leading-relaxed text-muted-foreground">
                  Reset links are intentionally short-lived for your security.
                </p>
              </div>
            </div>

            <div className="rounded-md border border-loss/25 bg-loss/[0.06] p-5">
              <div className="flex items-center gap-2.5">
                <AlertCircle className="h-4 w-4 text-loss" strokeWidth={2} />
                <span className="font-mono text-[10.5px] uppercase tracking-[0.22em] text-loss">
                  {state.reason.toUpperCase()}
                </span>
              </div>
              <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">
                {reasonText(state.reason)}
              </p>
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Link
                href="/forgot-password"
                className="group inline-flex items-center gap-2 rounded-md bg-signal px-5 py-2.5 font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-signal-foreground transition hover:brightness-110"
              >
                <RefreshCcw className="h-3.5 w-3.5" />
                Request a new link
                <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
              </Link>
              <Link
                href="/login"
                className="group inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground transition-colors hover:text-foreground"
              >
                <ArrowLeft className="h-3 w-3 transition-transform group-hover:-translate-x-0.5" />
                Back to sign in
              </Link>
            </div>
          </motion.div>
        )}

        {state.status === 'submitted' && (
          <motion.div
            key="submitted"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.6, ease: EASE }}
          >
            <div className="mb-8 flex items-start gap-5">
              <div className="rounded-md border border-signal/30 bg-signal/[0.06] p-2.5 backdrop-blur-sm">
                <KeyIllustration variant="success" />
              </div>
              <div>
                <h1 className="display-serif text-[34px] font-semibold leading-[1.05] tracking-[0.02em] sm:text-[40px]">
                  Password <span className="text-signal">updated</span>.
                </h1>
                <p className="mt-2 max-w-md text-[14px] leading-relaxed text-muted-foreground">
                  Re-arming the terminal — redirecting you to sign in.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3 font-mono text-[10.5px] uppercase tracking-[0.22em] text-signal">
              <CheckCircle2 className="h-4 w-4" strokeWidth={2} />
              <span>Discipline restored</span>
              <span className="ml-2 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-signal" />
            </div>
          </motion.div>
        )}

        {state.status === 'valid' && (
          <motion.div
            key="valid"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5, ease: EASE }}
          >
            <div className="mb-8 flex items-start gap-5">
              <div className="rounded-md border border-border bg-card/40 p-2.5 backdrop-blur-sm">
                <KeyIllustration variant={variant} />
              </div>
              <div>
                <h1 className="display-serif text-[34px] font-semibold leading-[1.05] tracking-[0.02em] sm:text-[40px]">
                  Set a new <span className="text-signal">key</span>.
                </h1>
                <p className="mt-2 max-w-md text-[14px] leading-relaxed text-muted-foreground">
                  Choose something you can remember — but nothing else can.
                </p>
              </div>
            </div>

            <form onSubmit={onSubmit} className="space-y-5">
              {/* New password */}
              <div>
                <label
                  htmlFor="password"
                  className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground"
                >
                  <Lock className="h-3 w-3 text-signal" strokeWidth={2.4} />
                  New password
                </label>
                <div className="relative">
                  <input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    required
                    autoFocus
                    autoComplete="new-password"
                    minLength={8}
                    placeholder="At least 8 characters"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full rounded-md border border-border bg-card/60 px-4 py-3 pr-12 font-mono text-[13px] text-foreground placeholder:text-subtle outline-none transition focus:border-signal/50 focus:bg-background"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" strokeWidth={1.6} />
                    ) : (
                      <Eye className="h-4 w-4" strokeWidth={1.6} />
                    )}
                  </button>
                </div>

                {/* Strength meter */}
                <div className="mt-2 flex items-center gap-2">
                  <div className="flex flex-1 gap-1">
                    {[0, 1, 2, 3].map((i) => (
                      <div
                        key={i}
                        className={`h-0.5 flex-1 rounded-full transition-colors duration-300 ${
                          i < strength.score
                            ? strength.score >= 3
                              ? 'bg-signal'
                              : strength.score >= 2
                                ? 'bg-warning'
                                : 'bg-loss'
                            : 'bg-border'
                        }`}
                      />
                    ))}
                  </div>
                  <span
                    className={`font-mono text-[9.5px] uppercase tracking-[0.22em] tabular-nums ${strength.tone}`}
                  >
                    {strength.label}
                  </span>
                </div>
              </div>

              {/* Confirm */}
              <div>
                <label
                  htmlFor="confirm"
                  className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground"
                >
                  <Lock className="h-3 w-3 text-signal" strokeWidth={2.4} />
                  Confirm password
                </label>
                <div className="relative">
                  <input
                    id="confirm"
                    type={showPassword ? 'text' : 'password'}
                    required
                    autoComplete="new-password"
                    minLength={8}
                    placeholder="Type it again"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    className="w-full rounded-md border border-border bg-card/60 px-4 py-3 pr-10 font-mono text-[13px] text-foreground placeholder:text-subtle outline-none transition focus:border-signal/50 focus:bg-background"
                  />
                  {confirm && (
                    <span
                      className={`pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 font-mono text-[12px] ${
                        matches ? 'text-signal' : 'text-loss'
                      }`}
                    >
                      {matches ? '✓' : '✕'}
                    </span>
                  )}
                </div>
              </div>

              {error && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex items-center gap-2.5 rounded-md border border-loss/30 bg-loss/[0.08] px-4 py-3"
                >
                  <AlertCircle className="h-4 w-4 shrink-0 text-loss" strokeWidth={2} />
                  <span className="font-mono text-[11.5px] text-loss">{error}</span>
                </motion.div>
              )}

              <button
                type="submit"
                disabled={submitting || !password || !confirm}
                className="group flex w-full items-center justify-center gap-2 rounded-md bg-signal py-3 font-mono text-[12px] font-semibold uppercase tracking-[0.22em] text-signal-foreground transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span>{submitting ? 'Setting key…' : 'Set new password'}</span>
                <ArrowRight
                  className={`h-4 w-4 transition-transform ${
                    submitting ? 'animate-pulse' : 'group-hover:translate-x-0.5'
                  }`}
                />
              </button>

              <div className="pt-2 text-center">
                <Link
                  href="/login"
                  className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground transition-colors hover:text-foreground"
                >
                  ← Cancel and sign in
                </Link>
              </div>
            </form>
          </motion.div>
        )}
      </AnimatePresence>
    </AuthShell>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center px-6">
          <span className="font-mono text-[11px] uppercase tracking-[0.22em] text-muted-foreground">
            Loading…
          </span>
        </div>
      }
    >
      <ResetPasswordInner />
    </Suspense>
  );
}
