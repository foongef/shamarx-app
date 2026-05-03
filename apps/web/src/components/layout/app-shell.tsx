'use client';

import { Sidebar } from './sidebar';
import { Topbar } from './topbar';
import { useState } from 'react';

export function AppShell({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Sidebar
        mobileOpen={mobileOpen}
        onCloseMobile={() => setMobileOpen(false)}
      />
      <div className="lg:pl-[228px]">
        <Topbar onOpenMobile={() => setMobileOpen(true)} />
        <main className="px-4 py-6 sm:px-6 lg:px-10">{children}</main>
      </div>
    </div>
  );
}
