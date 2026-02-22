'use client';

import Link from 'next/link';
import { Activity } from 'lucide-react';

export function NavBar() {
  return (
    <header className="border-b bg-card">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4">
        <Link href="/backtest" className="flex items-center gap-2 font-semibold">
          <Activity className="h-5 w-5 text-primary" />
          <span>XAUUSD Backtest</span>
        </Link>
      </div>
    </header>
  );
}
