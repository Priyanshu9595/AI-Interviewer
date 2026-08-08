'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { io, type Socket } from 'socket.io-client';
import { API_BASE } from '@/lib/api';

/**
 * The read-only view of the candidate's editor that the interviewer presents
 * into the meeting.
 *
 * Everything about this page is shaped by the fact that it is going to be seen
 * as a shared screen, on someone else's monitor, possibly a laptop across a
 * video call: large type, high contrast, dark background, no chrome, no
 * scrollbars to hunt for, nothing interactive. It is a display, not a tool.
 *
 * The document title is deliberately fixed and plain ASCII — the bot passes it
 * to Chromium as a command-line flag to auto-select this tab for sharing, so it
 * must not change with the candidate's name and must survive shell quoting.
 * It has to stay in step with SHARE_TAB_TITLE in the backend's browser.ts.
 */

const SHARE_TITLE = 'AI Interview Candidate Code';

interface MirrorState {
  code: string;
  language: string;
  submitted: { passed: number; total: number } | null;
}

export default function CodeSpectatorPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token ?? '';

  const [state, setState] = useState<MirrorState>({ code: '', language: 'javascript', submitted: null });
  const [meta, setMeta] = useState<{ candidateName: string; jobTitle: string } | null>(null);
  const [connected, setConnected] = useState(false);
  const codeRef = useRef<HTMLPreElement>(null);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    document.title = SHARE_TITLE;
  }, []);

  useEffect(() => {
    if (!token) return;

    const socket = io(`${API_BASE}/coding`, { transports: ['websocket', 'polling'] });
    socketRef.current = socket;

    socket.on('connect', () => {
      socket.emit(
        'join',
        { token },
        (res: { ok?: boolean; candidateName?: string; jobTitle?: string; state?: MirrorState | null }) => {
          setConnected(Boolean(res?.ok));
          if (res?.candidateName) {
            setMeta({ candidateName: res.candidateName, jobTitle: res.jobTitle ?? '' });
          }
          // Whatever was already typed, so presenting mid-round is not a blank screen.
          if (res?.state) setState(res.state);
        },
      );
    });

    socket.on('disconnect', () => setConnected(false));
    socket.on('code:update', (payload: MirrorState) => setState((s) => ({ ...s, ...payload })));
    socket.on('code:submitted', (summary: { passed: number; total: number }) =>
      setState((s) => ({ ...s, submitted: summary })),
    );

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [token]);

  // Follow the cursor: whoever is watching wants to see the line being written,
  // not the top of the file.
  useEffect(() => {
    const el = codeRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.code]);

  const lines = state.code ? state.code.split('\n') : [];

  return (
    <div className="flex h-screen flex-col bg-[#0b1020] text-slate-100">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-6 py-3">
        <div>
          <p className="text-base font-semibold tracking-tight">
            {meta?.candidateName ?? 'Candidate'} — live code
          </p>
          {meta?.jobTitle && <p className="text-sm text-slate-400">{meta.jobTitle}</p>}
        </div>

        <div className="flex items-center gap-3">
          <span className="rounded-full bg-slate-800 px-3 py-1 font-mono text-sm uppercase tracking-wide text-slate-300">
            {state.language}
          </span>

          {state.submitted ? (
            <span
              className={`rounded-full px-3 py-1 text-sm font-semibold ${
                state.submitted.passed === state.submitted.total
                  ? 'bg-emerald-500/15 text-emerald-300'
                  : 'bg-amber-500/15 text-amber-300'
              }`}
            >
              Submitted · {state.submitted.passed}/{state.submitted.total} passed
            </span>
          ) : (
            <span className="flex items-center gap-2 text-sm text-slate-400">
              <span
                className={`h-2 w-2 rounded-full ${connected ? 'animate-pulse bg-emerald-400' : 'bg-slate-600'}`}
              />
              {connected ? 'Live' : 'Connecting…'}
            </span>
          )}
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-hidden px-6 py-4">
        {lines.length === 0 ? (
          <div className="flex h-full items-center justify-center text-center">
            <p className="text-lg text-slate-500">
              Waiting for {meta?.candidateName ?? 'the candidate'} to start writing…
            </p>
          </div>
        ) : (
          <pre
            ref={codeRef}
            className="h-full overflow-auto rounded-lg bg-[#0f1629] p-5 font-mono text-[15px] leading-[1.65]"
          >
            {lines.map((line, i) => (
              <div key={i} className="flex">
                {/* Line numbers make it possible to talk about the code out loud. */}
                <span className="mr-5 w-8 shrink-0 select-none text-right text-slate-600">{i + 1}</span>
                <span className="whitespace-pre-wrap break-words text-slate-100">{line || ' '}</span>
              </div>
            ))}
          </pre>
        )}
      </main>
    </div>
  );
}
