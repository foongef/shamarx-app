import { cn } from '@/lib/utils';
import type { StrategyVersion } from '@/lib/types';

const META: Record<StrategyVersion, { label: string; tone: string; bar: string }> = {
  'V5.5b':  { label: 'V5.5b',  tone: 'text-strat-v5',    bar: 'bg-strat-v5' },
  'V6':     { label: 'V6',     tone: 'text-strat-v6',    bar: 'bg-strat-v6' },
  'V6-alt': { label: 'V6-ALT', tone: 'text-strat-v6alt', bar: 'bg-strat-v6alt' },
};

export function StrategyBadge({
  version,
  size = 'sm',
}: {
  version?: StrategyVersion | null;
  size?: 'xs' | 'sm' | 'md';
}) {
  if (!version) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-sm border border-border px-1.5 py-0.5 font-mono text-[10px] tracking-widest text-subtle">
        —
      </span>
    );
  }
  const m = META[version];
  const padding =
    size === 'xs'
      ? 'px-1.5 py-px text-[9.5px]'
      : size === 'md'
      ? 'px-2 py-0.5 text-[11px]'
      : 'px-1.5 py-0.5 text-[10px]';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-sm border border-border bg-surface font-mono uppercase tracking-widest',
        padding,
        m.tone,
      )}
    >
      <span className={cn('h-1 w-1 rounded-full', m.bar)} />
      {m.label}
    </span>
  );
}
