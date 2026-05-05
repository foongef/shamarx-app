'use client';

import { useEffect, useState } from 'react';

export function formatDuration(ms: number): string {
  if (ms < 0) return '0s';
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86_400);
  const hours = Math.floor((totalSec % 86_400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m ${String(secs).padStart(2, '0')}s`;
  if (mins > 0) return `${mins}m ${String(secs).padStart(2, '0')}s`;
  return `${secs}s`;
}

export function LiveDot({ running, since }: { running: boolean; since: string | null }) {
  const [, force] = useState(0);
  useEffect(() => {
    if (!running || !since) return;
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [running, since]);

  const duration = running && since ? formatDuration(Date.now() - new Date(since).getTime()) : null;

  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-1.5">
      {running ? (
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
        </span>
      ) : (
        <span className="h-2 w-2 rounded-full bg-muted-foreground/40" />
      )}
      <span className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
        {running ? 'LIVE' : 'PAUSED'}
      </span>
      {duration && (
        <>
          <span className="h-3 w-px bg-border" />
          <span
            className="font-mono text-[11px] tabular-nums text-foreground"
            title={`Started at ${new Date(since!).toLocaleString()}`}
          >
            {duration}
          </span>
        </>
      )}
    </div>
  );
}
