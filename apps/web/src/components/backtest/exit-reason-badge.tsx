import { cn } from '@/lib/utils';

const META: Record<string, { label: string; className: string }> = {
  TP:           { label: 'TP',           className: 'text-profit border-profit/30 bg-profit/5' },
  SL:           { label: 'SL',           className: 'text-loss border-loss/30 bg-loss/5' },
  BREAKEVEN:    { label: 'BE',           className: 'text-muted-foreground border-border bg-surface' },
  FORCED_CLOSE: { label: 'FORCE',        className: 'text-warning border-warning/30 bg-warning/5' },
};

export function ExitReasonBadge({ reason }: { reason: string }) {
  const m = META[reason] ?? {
    label: reason,
    className: 'text-muted-foreground border-border',
  };
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-sm border px-1.5 py-px font-mono text-[9.5px] uppercase tracking-widest',
        m.className,
      )}
    >
      {m.label}
    </span>
  );
}
