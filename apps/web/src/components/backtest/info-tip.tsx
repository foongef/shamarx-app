'use client';

import { useState, useRef, useEffect } from 'react';
import { cn } from '@/lib/utils';

/**
 * InfoTip — small "ⓘ" affordance with a click-toggleable bubble.
 * Click outside to dismiss. Keyboard-friendly (Esc to close).
 *
 * Used inline next to form labels and column headers to explain numeric
 * fields without cluttering the layout.
 */
export function InfoTip({
  title,
  children,
  side = 'right',
  className,
}: {
  title?: string;
  children: React.ReactNode;
  side?: 'right' | 'left' | 'top' | 'bottom';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const positions: Record<string, string> = {
    right: 'left-full ml-2 top-1/2 -translate-y-1/2',
    left: 'right-full mr-2 top-1/2 -translate-y-1/2',
    top: 'bottom-full mb-2 left-1/2 -translate-x-1/2',
    bottom: 'top-full mt-2 left-1/2 -translate-x-1/2',
  };

  return (
    <span
      ref={ref}
      className={cn('relative inline-flex items-center', className)}
    >
      <button
        type="button"
        aria-label={title ? `Info: ${title}` : 'Info'}
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault();
          setOpen((v) => !v);
        }}
        onMouseEnter={() => setOpen(true)}
        className={cn(
          'inline-flex h-4 w-4 items-center justify-center rounded-full border border-border bg-surface font-mono text-[9px] leading-none text-muted-foreground transition-colors',
          'hover:border-signal hover:text-signal',
          open && 'border-signal text-signal',
        )}
      >
        i
      </button>
      {open && (
        <span
          role="tooltip"
          className={cn(
            'absolute z-50 w-[280px] border border-border-strong bg-card p-3 text-[12px] leading-relaxed text-foreground shadow-2xl',
            'reveal-up',
            positions[side],
          )}
        >
          {/* corner accent */}
          <span
            aria-hidden
            className={cn(
              'pointer-events-none absolute h-1.5 w-1.5 border-signal',
              side === 'right' && '-left-px top-3 border-l border-t',
              side === 'left' && '-right-px top-3 border-r border-t',
              side === 'top' && '-bottom-px left-3 border-l border-b',
              side === 'bottom' && '-top-px left-3 border-l border-t',
            )}
          />
          {title && (
            <div className="label-eyebrow mb-1.5">
              <span className="text-signal">◆</span>&nbsp;{title}
            </div>
          )}
          <div className="space-y-1.5 text-muted-foreground [&_strong]:font-medium [&_strong]:text-foreground [&_code]:font-mono [&_code]:text-[11px] [&_code]:text-foreground">
            {children}
          </div>
        </span>
      )}
    </span>
  );
}
