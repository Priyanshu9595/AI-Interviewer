'use client';

import { Bot, Mic, User } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The two-sided presence indicator. Which orb is lit tells the candidate
 * whose turn it is without them having to read anything.
 */
export function VoiceOrb({
  role,
  active,
  level = 0,
  label,
  sublabel,
}: {
  role: 'interviewer' | 'candidate';
  active: boolean;
  /** 0..1 audio level, drives the ring size while speaking. */
  level?: number;
  label: string;
  sublabel: string;
}) {
  const isAi = role === 'interviewer';
  const Icon = isAi ? Bot : User;

  const scale = 1 + Math.min(0.22, level * 0.3);

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative flex h-24 w-24 items-center justify-center sm:h-28 sm:w-28">
        {/* Expanding ring only while this side is actually speaking. */}
        {active && (
          <span
            className={cn(
              'absolute inset-0 rounded-full animate-pulse-ring',
              isAi ? 'bg-primary/25' : 'bg-success/25',
            )}
          />
        )}

        {/* Level-reactive halo */}
        <span
          className={cn(
            'absolute inset-0 rounded-full transition-transform duration-100',
            active ? (isAi ? 'bg-primary/15' : 'bg-success/15') : 'bg-muted',
          )}
          style={{ transform: `scale(${active ? scale : 1})` }}
        />

        <span
          className={cn(
            'relative flex h-16 w-16 items-center justify-center rounded-full transition-colors sm:h-[4.5rem] sm:w-[4.5rem]',
            active
              ? isAi
                ? 'bg-primary text-primary-foreground'
                : 'bg-success text-white'
              : 'bg-surface text-muted-foreground ring-1 ring-border',
          )}
        >
          <Icon className="h-7 w-7" />
        </span>
      </div>

      <div className="text-center">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p
          className={cn(
            'mt-0.5 flex items-center justify-center gap-1 text-xs',
            active ? (isAi ? 'text-primary' : 'text-success') : 'text-muted-foreground',
          )}
        >
          {!isAi && active && <Mic className="h-3 w-3" />}
          {sublabel}
        </p>
      </div>
    </div>
  );
}
