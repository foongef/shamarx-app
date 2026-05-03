'use client';

import { useEffect, useState } from 'react';

export function TimeStamp() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!now) {
    return (
      <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
        --:--:-- UTC
      </span>
    );
  }

  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  const ss = String(now.getUTCSeconds()).padStart(2, '0');
  const date = now.toISOString().slice(0, 10);

  return (
    <div className="hidden items-baseline gap-1.5 sm:flex">
      <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
        {date}
      </span>
      <span className="font-mono text-[12px] tabular-nums text-foreground">
        {hh}:{mm}:{ss}
      </span>
      <span className="font-mono text-[10px] uppercase tracking-widest text-subtle">
        UTC
      </span>
    </div>
  );
}
