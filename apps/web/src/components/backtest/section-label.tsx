import { cn } from '@/lib/utils';

export function SectionLabel({
  children,
  count,
  accent,
  className,
}: {
  children: React.ReactNode;
  count?: string | number;
  accent?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <span className="text-signal opacity-70" aria-hidden>
        ◆
      </span>
      <span
        className={cn(
          'label-eyebrow',
          accent && 'text-foreground',
        )}
      >
        {children}
      </span>
      {typeof count !== 'undefined' && (
        <span className="font-mono text-[10px] tabular-nums text-subtle">
          [{String(count).padStart(2, '0')}]
        </span>
      )}
    </div>
  );
}
