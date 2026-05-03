import { cn } from '@/lib/utils';

interface MetricChipProps {
  label: string;
  value: string;
  /** small caption underneath, e.g. "vs avg" */
  caption?: string;
  /** affects color: positive (profit), negative (loss), neutral, signal */
  tone?: 'profit' | 'loss' | 'neutral' | 'signal' | 'default';
  /** smaller compact variant for sidebars */
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const TONE_CLASS: Record<NonNullable<MetricChipProps['tone']>, string> = {
  profit:  'text-profit',
  loss:    'text-loss',
  signal:  'text-signal',
  neutral: 'text-muted-foreground',
  default: 'text-foreground',
};

export function MetricChip({
  label,
  value,
  caption,
  tone = 'default',
  size = 'md',
  className,
}: MetricChipProps) {
  return (
    <div
      className={cn(
        'group flex flex-col gap-1 border-l border-border/70 pl-3',
        size === 'lg' && 'pl-4',
        className,
      )}
    >
      <span className="label-eyebrow">{label}</span>
      <span
        className={cn(
          'font-mono font-medium tnum leading-none',
          size === 'sm' && 'text-[14px]',
          size === 'md' && 'text-[18px]',
          size === 'lg' && 'text-[26px] tracking-tight',
          TONE_CLASS[tone],
        )}
      >
        {value}
      </span>
      {caption && (
        <span className="font-mono text-[10px] text-subtle tnum">
          {caption}
        </span>
      )}
    </div>
  );
}
