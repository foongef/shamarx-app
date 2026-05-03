import { cn } from '@/lib/utils';
import type { BacktestStatus } from '@/lib/types';

const TONE: Record<BacktestStatus, string> = {
  COMPLETED: 'bg-profit',
  RUNNING: 'bg-signal',
  PENDING: 'bg-warning',
  FAILED: 'bg-loss',
};

export function StatusDot({ status }: { status: BacktestStatus }) {
  const tone = TONE[status] ?? 'bg-muted-foreground';
  const live = status === 'RUNNING' || status === 'PENDING';
  return (
    <span className="relative inline-flex h-2 w-2 shrink-0 items-center justify-center">
      <span className={cn('h-1.5 w-1.5 rounded-full', tone)} />
      {live && (
        <span
          className={cn(
            'absolute inset-0 animate-ping rounded-full opacity-50',
            tone,
          )}
        />
      )}
    </span>
  );
}
