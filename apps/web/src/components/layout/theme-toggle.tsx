'use client';

import { useTheme } from 'next-themes';
import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';

export function ThemeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const current = theme ?? resolvedTheme;
  const isDark = current === 'dark';

  return (
    <button
      type="button"
      aria-label="Toggle theme"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      className="group relative flex h-7 w-7 items-center justify-center rounded-sm border border-border transition-colors hover:border-border-strong"
    >
      {mounted ? (
        isDark ? (
          <Sun className="h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground" strokeWidth={1.75} />
        ) : (
          <Moon className="h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground" strokeWidth={1.75} />
        )
      ) : (
        <span className="h-3.5 w-3.5" />
      )}
    </button>
  );
}
