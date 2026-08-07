'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  BarChart3,
  Brain,
  CalendarClock,
  FileText,
  LayoutDashboard,
  LogOut,
  Menu,
  Users,
  Video,
  X,
} from 'lucide-react';
import { useAuth } from '@/components/AuthProvider';
import { avatarColor, cn, initials } from '@/lib/utils';

const NAV = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/sessions', label: 'Interview sessions', icon: CalendarClock },
  { href: '/candidates', label: 'Candidates', icon: Users },
  { href: '/reports', label: 'Reports', icon: FileText },
  { href: '/recordings', label: 'Recordings', icon: Video },
  { href: '/analytics', label: 'Analytics', icon: BarChart3 },
];

export function Sidebar() {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  const nav = (
    <nav className="flex-1 space-y-0.5 px-3 py-3">
      {NAV.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          onClick={() => setOpen(false)}
          className={cn(
            'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors',
            isActive(href)
              ? 'bg-indigo-500/15 text-indigo-400'
              : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100',
          )}
        >
          <Icon className="h-4 w-4 shrink-0" />
          <span className="truncate">{label}</span>
        </Link>
      ))}
    </nav>
  );

  const footer = user && (
    <div className="border-t border-slate-800 p-3">
      <div className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
        <div
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
            avatarColor(user.name ?? user.email),
          )}
        >
          {initials(user.name ?? user.email)}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-slate-200">{user.name ?? 'Recruiter'}</p>
          <p className="truncate text-xs text-slate-400">{user.email}</p>
        </div>
        <button
          onClick={() => void logout()}
          className="shrink-0 rounded p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100"
          aria-label="Sign out"
          title="Sign out"
        >
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </div>
  );

  const brand = (
    <Link href="/dashboard" className="flex items-center gap-2 border-b border-slate-800 px-5 py-4">
      <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <Brain className="h-4 w-4" />
      </div>
      <span className="text-sm font-semibold tracking-tight text-white">AI Interview</span>
    </Link>
  );

  return (
    <>
      {/* Mobile top bar */}
      <div className="sticky top-0 z-30 flex items-center justify-between border-b border-border bg-surface px-4 py-3 lg:hidden">
        <Link href="/dashboard" className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Brain className="h-4 w-4" />
          </div>
          <span className="text-sm font-semibold">AI Interview</span>
        </Link>
        <button
          onClick={() => setOpen(true)}
          className="rounded-md p-2 text-muted-foreground hover:bg-muted"
          aria-label="Open navigation"
        >
          <Menu className="h-5 w-5" />
        </button>
      </div>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-foreground/25" onClick={() => setOpen(false)} aria-hidden />
          <aside className="relative flex h-full w-72 flex-col bg-slate-950 text-slate-100 shadow-pop">
            <div className="flex items-center justify-between border-b border-slate-800 pr-2">
              <div className="flex-1">{brand}</div>
              <button onClick={() => setOpen(false)} className="rounded-md p-2 hover:bg-slate-800 text-slate-400 hover:text-slate-100" aria-label="Close">
                <X className="h-5 w-5" />
              </button>
            </div>
            {nav}
            {footer}
          </aside>
        </div>
      )}

      {/* Desktop rail */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-slate-800 bg-slate-950 text-slate-100 lg:flex">
        {brand}
        {nav}
        {footer}
      </aside>
    </>
  );
}
