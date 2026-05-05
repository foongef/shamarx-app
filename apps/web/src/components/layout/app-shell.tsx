'use client';

import { Sidebar } from './sidebar';
import { Topbar } from './topbar';
import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';

const PUBLIC_ROUTES = ['/login', '/forgot-password', '/reset-password'];
const MARKETING_ROUTES = ['/']; // landing page is fully public + has its own chrome

function isPublicRoute(pathname: string): boolean {
  return PUBLIC_ROUTES.some(
    (p) => pathname === p || pathname.startsWith(`${p}?`),
  );
}

function isMarketingRoute(pathname: string): boolean {
  return MARKETING_ROUTES.includes(pathname);
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, isLoading } = useAuth();
  const isPublic = isPublicRoute(pathname);
  const isMarketing = isMarketingRoute(pathname);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    if (!isLoading && !user && !isPublic && !isMarketing) {
      router.replace('/login');
    }
  }, [isLoading, user, isPublic, isMarketing, router]);

  // Close drawer on route change
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // Lock body scroll while drawer is open
  useEffect(() => {
    if (!mobileOpen) return;
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = original;
    };
  }, [mobileOpen]);

  // Marketing landing — page handles its own chrome (navbar + footer)
  if (isMarketing) {
    return (
      <div className="min-h-screen overflow-x-hidden bg-background text-foreground">
        {children}
      </div>
    );
  }

  if (isPublic) {
    return (
      <div className="min-h-screen overflow-x-hidden bg-background text-foreground grain-overlay">
        {children}
      </div>
    );
  }

  if (isLoading || !user) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
          <span className="relative inline-block h-1.5 w-1.5 rounded-full bg-signal">
            <span className="absolute inset-0 animate-ping rounded-full bg-signal opacity-60" />
          </span>
          <span className="font-mono text-[11px] uppercase tracking-widest">Authorising</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen overflow-x-hidden bg-background text-foreground grain-overlay">
      <Sidebar
        mobileOpen={mobileOpen}
        onCloseMobile={() => setMobileOpen(false)}
      />
      <div className="lg:pl-[228px]">
        <Topbar onOpenMobile={() => setMobileOpen(true)} />
        <main className="px-4 py-5 sm:px-6 lg:px-10 lg:py-7">
          {children}
        </main>
      </div>
    </div>
  );
}
