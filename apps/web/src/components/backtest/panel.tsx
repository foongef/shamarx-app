import { cn } from '@/lib/utils';
import { SectionLabel } from './section-label';

interface PanelProps {
  title?: string;
  count?: number | string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  brackets?: boolean;
  children: React.ReactNode;
}

/**
 * Panel — the workhorse container of the dashboard.
 * Has a label-eyebrow header, optional ASCII frame brackets (signature touch),
 * sharp 1-px borders, surface fill that distinguishes from the page.
 */
export function Panel({
  title,
  count,
  subtitle,
  actions,
  className,
  bodyClassName,
  brackets = false,
  children,
}: PanelProps) {
  return (
    <section
      className={cn(
        'relative border border-border bg-card',
        brackets && 'frame-brackets',
        className,
      )}
    >
      {(title || actions) && (
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex flex-col gap-0.5">
            {title && <SectionLabel count={count}>{title}</SectionLabel>}
            {subtitle && (
              <div className="text-[12px] text-muted-foreground">
                {subtitle}
              </div>
            )}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn('p-4', bodyClassName)}>{children}</div>
    </section>
  );
}
