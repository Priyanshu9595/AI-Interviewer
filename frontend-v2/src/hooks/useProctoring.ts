'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';

export interface ProctoringState {
  /** How many times the candidate has left the interview tab. */
  violations: number;
  /** Shown over the interview while they are away or immediately after. */
  warning: string | null;
  dismissWarning: () => void;
}

/**
 * Discourages a candidate from leaving the interview tab.
 *
 * A browser cannot actually prevent tab switching — no web page can. What it
 * can do is notice, warn clearly, and record it for the recruiter, which is
 * what an honest proctoring feature looks like. Pretending otherwise would be
 * security theatre.
 *
 * Copy, paste and the context menu are blocked during the interview because
 * those are cheap to enforce and are the common route for pasting a prepared
 * answer.
 */
export function useProctoring({
  socket,
  active,
  maxViolations = 3,
  onLimitReached,
}: {
  socket: Socket | null;
  active: boolean;
  maxViolations?: number;
  onLimitReached?: () => void;
}): ProctoringState {
  const [violations, setViolations] = useState(0);
  const [warning, setWarning] = useState<string | null>(null);
  const leftAtRef = useRef<number | null>(null);
  const limitFiredRef = useRef(false);

  const report = useCallback(
    (type: string, detail: string, awayMs?: number) => {
      socket?.emit('proctoring_event', { type, detail, awayMs });
    },
    [socket],
  );

  useEffect(() => {
    if (!active) return;

    const handleHidden = () => {
      leftAtRef.current = Date.now();
    };

    const handleVisible = () => {
      const awayMs = leftAtRef.current ? Date.now() - leftAtRef.current : 0;
      leftAtRef.current = null;

      // Ignore a momentary flicker: some browsers fire visibilitychange when a
      // permission prompt or the OS overlay appears.
      if (awayMs < 700) return;

      setViolations((count) => {
        const next = count + 1;
        const seconds = Math.round(awayMs / 1000);

        report('TAB_SWITCH', `Left the interview tab for ${seconds}s`, awayMs);

        setWarning(
          next >= maxViolations
            ? `You have left the interview ${next} times. This has been recorded and shared with the recruiter.`
            : `Please stay on this tab. Leaving the interview is recorded. (${next} of ${maxViolations})`,
        );

        if (next >= maxViolations && !limitFiredRef.current) {
          limitFiredRef.current = true;
          onLimitReached?.();
        }

        return next;
      });
    };

    const onVisibilityChange = () => {
      if (document.hidden) handleHidden();
      else handleVisible();
    };

    // `blur` catches switching to another application, which does not always
    // set document.hidden.
    const onBlur = () => {
      if (!document.hidden) handleHidden();
    };
    const onFocus = () => {
      if (!document.hidden && leftAtRef.current) handleVisible();
    };

    const block = (e: Event) => {
      e.preventDefault();
      setWarning('Copying and pasting is disabled during the interview.');
      report('CLIPBOARD', `Blocked ${e.type}`);
    };

    const blockContextMenu = (e: MouseEvent) => e.preventDefault();

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    document.addEventListener('copy', block);
    document.addEventListener('paste', block);
    document.addEventListener('cut', block);
    document.addEventListener('contextmenu', blockContextMenu);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('copy', block);
      document.removeEventListener('paste', block);
      document.removeEventListener('cut', block);
      document.removeEventListener('contextmenu', blockContextMenu);
    };
  }, [active, maxViolations, onLimitReached, report]);

  // Warnings clear themselves so they do not obscure the interview.
  useEffect(() => {
    if (!warning) return;
    const timer = setTimeout(() => setWarning(null), 6000);
    return () => clearTimeout(timer);
  }, [warning]);

  return { violations, warning, dismissWarning: () => setWarning(null) };
}
