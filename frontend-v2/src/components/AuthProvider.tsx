'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, setAccessToken } from '@/lib/api';

export interface User {
  id: string;
  email: string;
  name: string | null;
  company: string | null;
  role: string;
}

interface AuthContextValue {
  user: User | null;
  /** True until the initial refresh attempt settles. */
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (input: { email: string; password: string; name?: string; company?: string }) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  // On mount, try the refresh cookie so a reload does not log the user out.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await api.post<{ accessToken: string; user: User }>('/auth/refresh');
        if (cancelled) return;
        setAccessToken(res.data.accessToken);
        setUser(res.data.user);
      } catch {
        if (!cancelled) {
          setAccessToken(null);
          setUser(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.post<{ accessToken: string; user: User }>('/auth/login', { email, password });
    setAccessToken(res.data.accessToken);
    setUser(res.data.user);
  }, []);

  const register = useCallback(
    async (input: { email: string; password: string; name?: string; company?: string }) => {
      const res = await api.post<{ accessToken: string; user: User }>('/auth/register', input);
      setAccessToken(res.data.accessToken);
      setUser(res.data.user);
    },
    [],
  );

  const logout = useCallback(async () => {
    await api.post('/auth/logout').catch(() => {});
    setAccessToken(null);
    setUser(null);
    router.push('/');
  }, [router]);

  const value = useMemo(() => ({ user, loading, login, register, logout }), [user, loading, login, register, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside an AuthProvider');
  return ctx;
}
