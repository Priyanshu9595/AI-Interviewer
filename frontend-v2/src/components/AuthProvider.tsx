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
  /** Sends a verification code to the address. No account exists until it is confirmed. */
  startRegister: (input: {
    email: string;
    password: string;
    name?: string;
    company?: string;
  }) => Promise<{ expiresInSeconds: number; resendInSeconds: number }>;
  /** Confirms the code, which is what actually creates the account and signs in. */
  confirmRegister: (input: { email: string; code: string }) => Promise<void>;
  /** Issues a fresh code for a sign-up already in flight. */
  resendRegisterCode: (email: string) => Promise<{ expiresInSeconds: number }>;
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

  const startRegister = useCallback(
    async (input: { email: string; password: string; name?: string; company?: string }) => {
      const res = await api.post<{ expiresInSeconds: number; resendInSeconds: number }>(
        '/auth/register/start',
        input,
      );
      return res.data;
    },
    [],
  );

  const confirmRegister = useCallback(async (input: { email: string; code: string }) => {
    const res = await api.post<{ accessToken: string; user: User }>('/auth/register/verify', input);
    setAccessToken(res.data.accessToken);
    setUser(res.data.user);
  }, []);

  const resendRegisterCode = useCallback(async (email: string) => {
    const res = await api.post<{ expiresInSeconds: number }>('/auth/register/resend', { email });
    return res.data;
  }, []);

  const logout = useCallback(async () => {
    await api.post('/auth/logout').catch(() => {});
    setAccessToken(null);
    setUser(null);
    router.push('/');
  }, [router]);

  const value = useMemo(
    () => ({ user, loading, login, startRegister, confirmRegister, resendRegisterCode, logout }),
    [user, loading, login, startRegister, confirmRegister, resendRegisterCode, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside an AuthProvider');
  return ctx;
}
