'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { motion, useScroll, useTransform } from 'motion/react';
import { ShamarxLogo } from '@/components/brand/shamarx-logo';
import { useAuth } from '@/contexts/AuthContext';
import { ArrowRight } from 'lucide-react';

const NAV_LINKS = [
  { href: '#modules', label: 'Modules' },
  { href: '#how', label: 'How it works' },
  { href: '#strategy', label: 'Strategy' },
  { href: '#principles', label: 'Principles' },
];

function scrollToTop() {
  if (typeof window === 'undefined') return;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

export function LandingNavbar() {
  const { user } = useAuth();
  const { scrollY } = useScroll();
  const shellOpacity = useTransform(scrollY, [0, 80], [0.55, 0.92]);
  const shellBorder = useTransform(scrollY, [0, 80], [0.18, 0.5]);
  const shellShadow = useTransform(
    scrollY,
    [0, 80],
    ['0 0 0 0 rgba(0,0,0,0)', '0 18px 40px -18px rgba(0,0,0,0.6)'],
  );
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = original;
    };
  }, [open]);

  return (
    <>
      <motion.header
        className="fixed inset-x-0 top-0 z-40 px-3 pt-3 sm:px-6 sm:pt-5"
        initial={{ y: -16, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      >
        <motion.div
          style={{
            backgroundColor: useTransform(
              shellOpacity,
              (v) => `oklch(0.115 0.006 65 / ${v})`,
            ),
            borderColor: useTransform(
              shellBorder,
              (v) => `oklch(0.27 0.008 75 / ${v})`,
            ),
            boxShadow: shellShadow,
          }}
          className="mx-auto flex h-[68px] max-w-[1240px] items-center justify-between rounded-full border px-4 backdrop-blur-xl sm:h-[76px] sm:px-6"
        >
          <button
            onClick={scrollToTop}
            aria-label="Back to top"
            className="group flex items-center transition-opacity hover:opacity-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal/60 rounded-full"
          >
            <ShamarxLogo
              variant="horizontal"
              height={42}
              priority
              className="transition-transform duration-500 group-hover:scale-[1.02]"
            />
          </button>

          <nav className="hidden items-center gap-8 lg:flex">
            {NAV_LINKS.map((l) => (
              <a
                key={l.href}
                href={l.href}
                className="relative font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground transition-colors hover:text-foreground after:absolute after:-bottom-1.5 after:left-0 after:h-px after:w-full after:origin-left after:scale-x-0 after:bg-signal after:transition-transform after:duration-300 hover:after:scale-x-100"
              >
                {l.label}
              </a>
            ))}
          </nav>

          <div className="flex items-center gap-2 sm:gap-3">
            {user ? (
              <Link
                href="/dashboard"
                className="group inline-flex items-center gap-2 rounded-full bg-signal px-5 py-2.5 font-mono text-[11px] font-semibold uppercase tracking-[0.2em] text-signal-foreground transition hover:brightness-110"
              >
                Dashboard
                <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
              </Link>
            ) : (
              <>
                <Link
                  href="/login"
                  className="hidden font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground transition hover:text-foreground sm:inline-block"
                >
                  Sign in
                </Link>
                <Link
                  href="/login"
                  className="group inline-flex items-center gap-2 rounded-full bg-signal px-5 py-2.5 font-mono text-[11px] font-semibold uppercase tracking-[0.2em] text-signal-foreground transition hover:brightness-110"
                >
                  Get Access
                  <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                </Link>
              </>
            )}
            <button
              onClick={() => setOpen((v) => !v)}
              aria-label="Toggle menu"
              className="-mr-1 inline-flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground transition hover:bg-card hover:text-foreground lg:hidden"
            >
              <span className="relative block h-3 w-4">
                <span
                  className={`absolute left-0 top-0 h-px w-4 bg-current transition-transform ${
                    open ? 'translate-y-1.5 rotate-45' : ''
                  }`}
                />
                <span
                  className={`absolute left-0 top-1.5 h-px w-4 bg-current transition-opacity ${
                    open ? 'opacity-0' : ''
                  }`}
                />
                <span
                  className={`absolute left-0 top-3 h-px w-4 bg-current transition-transform ${
                    open ? '-translate-y-1.5 -rotate-45' : ''
                  }`}
                />
              </span>
            </button>
          </div>
        </motion.div>
      </motion.header>

      {/* Mobile menu */}
      <motion.div
        initial={false}
        animate={{ opacity: open ? 1 : 0, pointerEvents: open ? 'auto' : 'none' }}
        transition={{ duration: 0.25 }}
        className="fixed inset-0 z-30 lg:hidden"
      >
        <div
          className="absolute inset-0 bg-background/95 backdrop-blur-xl"
          onClick={() => setOpen(false)}
        />
        <motion.nav
          initial={false}
          animate={{ y: open ? 0 : -16, opacity: open ? 1 : 0 }}
          transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
          className="relative flex h-full flex-col items-center justify-center gap-7 px-8"
        >
          {NAV_LINKS.map((l, i) => (
            <motion.a
              key={l.href}
              href={l.href}
              onClick={() => setOpen(false)}
              initial={{ opacity: 0, y: 8 }}
              animate={{
                opacity: open ? 1 : 0,
                y: open ? 0 : 8,
                transition: { delay: 0.08 + i * 0.06 },
              }}
              className="display-serif text-[28px] font-medium uppercase tracking-[0.06em]"
            >
              {l.label}
            </motion.a>
          ))}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: open ? 1 : 0, transition: { delay: 0.4 } }}
            className="mt-6"
          >
            <Link
              href="/login"
              onClick={() => setOpen(false)}
              className="inline-flex items-center gap-2 rounded-md bg-signal px-6 py-3 font-mono text-[12px] font-semibold uppercase tracking-[0.22em] text-signal-foreground"
            >
              Get Access
              <ArrowRight className="h-4 w-4" />
            </Link>
          </motion.div>
        </motion.nav>
      </motion.div>
    </>
  );
}
