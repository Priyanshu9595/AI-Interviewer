'use client';

import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { API_BASE, getAccessToken } from '@/lib/api';
import type { MeetBotStatus, TranscriptMessage } from '@/lib/meetInterview';

/**
 * Live view of one Google Meet interview.
 *
 * The socket carries what is happening now; the transcript endpoint carries
 * what already happened. This hook only owns the first — the page loads history
 * once and lets new turns arrive here, which keeps a recruiter who opens the
 * page twenty minutes in from seeing an empty panel.
 *
 * Polling backs it up rather than replacing it: if the socket cannot connect at
 * all, the status still advances, just less promptly.
 */

export interface LiveMessage {
  speaker: 'AI' | 'CANDIDATE' | 'SYSTEM';
  text: string;
  at: string;
}

export interface MeetBotLive {
  connected: boolean;
  status: MeetBotStatus | null;
  detail: string | null;
  error: { code: string; message: string } | null;
  messages: LiveMessage[];
  /** Partial transcription of what the candidate is saying right now. */
  interim: string;
  questionCount: number;
  /** True once the bot reports the interview finished. */
  completed: boolean;
}

const EMPTY: MeetBotLive = {
  connected: false,
  status: null,
  detail: null,
  error: null,
  messages: [],
  interim: '',
  questionCount: 0,
  completed: false,
};

export function useMeetBot(interviewId: string | null, enabled = true): MeetBotLive {
  const [state, setState] = useState<MeetBotLive>(EMPTY);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!interviewId || !enabled) return;

    const token = getAccessToken();
    if (!token) return;

    const socket = io(`${API_BASE}/meet-bot`, {
      auth: { token },
      transports: ['websocket', 'polling'],
      withCredentials: true,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setState((s) => ({ ...s, connected: true }));
      socket.emit('subscribe', { interviewId });
    });

    socket.on('disconnect', () => setState((s) => ({ ...s, connected: false })));

    socket.on('interview:status', (payload: { status: MeetBotStatus; detail?: string | null }) =>
      setState((s) => ({ ...s, status: payload.status, detail: payload.detail ?? null })),
    );

    socket.on('interview:message', (payload: LiveMessage) =>
      setState((s) => {
        // The replay buffer overlaps with what is already on screen after a
        // reconnect; matching on speaker and text is enough to drop the repeat.
        const last = s.messages[s.messages.length - 1];
        if (last && last.speaker === payload.speaker && last.text === payload.text) return s;
        return { ...s, messages: [...s.messages, payload], interim: '' };
      }),
    );

    socket.on('interview:question', () => setState((s) => ({ ...s, questionCount: s.questionCount + 1 })));

    socket.on('interview:interim', (payload: { text: string }) =>
      setState((s) => ({ ...s, interim: payload.text })),
    );

    socket.on('interview:answer', () => setState((s) => ({ ...s, interim: '' })));

    socket.on('interview:completed', () => setState((s) => ({ ...s, completed: true, interim: '' })));

    socket.on('interview:error', (payload: { code: string; message: string }) =>
      setState((s) => ({ ...s, error: payload })),
    );

    return () => {
      socket.emit('unsubscribe', { interviewId });
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
      setState(EMPTY);
    };
  }, [interviewId, enabled]);

  return state;
}

/** Merges stored transcript turns with turns that arrived over the socket. */
export function mergeTranscript(stored: TranscriptMessage[], live: LiveMessage[]): TranscriptMessage[] {
  if (!live.length) return stored;

  const seen = new Set(stored.map((m) => `${m.speaker}::${m.message}`));
  const extra: TranscriptMessage[] = [];

  for (const message of live) {
    const key = `${message.speaker}::${message.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    extra.push({
      id: `live-${message.at}-${extra.length}`,
      speaker: message.speaker,
      message: message.text,
      timestamp: message.at,
      round: null,
      questionNumber: null,
    });
  }

  return [...stored, ...extra];
}
