'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { api, AuthUser, ApiError } from '@/lib/api-client';

interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const router = useRouter();

  const loadCurrentUser = useCallback(async () => {
    try {
      const res = await api.me();
      setUser(res.user);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // Try to refresh first — access token might just be expired
        try {
          const refreshed = await api.refresh();
          if (refreshed.user) {
            setUser(refreshed.user);
            return;
          }
        } catch {
          // refresh failed; user is not authenticated
        }
      }
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCurrentUser();
  }, [loadCurrentUser]);

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await api.login(email, password);
      setUser(res.user);
      router.push('/');
    },
    [router],
  );

  const logout = useCallback(async () => {
    await api.logout();
    setUser(null);
    router.push('/login');
  }, [router]);

  return (
    <AuthContext.Provider value={{ user, isLoading, login, logout, refresh: loadCurrentUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
