'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { io, type Socket } from 'socket.io-client';
import { AlertTriangle, Bot, CheckCircle2, Code2, ScreenShare } from 'lucide-react';
import { CodingPanel, type CodingChallenge } from '@/components/interview/CodingPanel';
import { Alert, Badge, Card, CardBody, Spinner } from '@/components/ui';
import { API_BASE, api, errorMessage } from '@/lib/api';

/**
 * The candidate's code editor for an interview running inside a meeting call.
 *
 * Google Meet, Zoom and Teams have no shared editor, so the coding round moves
 * to a browser tab. The interviewer stays in the meeting, posts this link into
 * the chat when the round starts, and picks the conversation back up as soon as
 * a solution is submitted — the submission itself is what tells it to continue.
 *
 * Authenticated by the same access token as the interview room, so there is no
 * login and nothing new to remember. The candidate keeps the meeting open in
 * another window and talks through their thinking as they work.
 */

interface ChallengeResponse {
  candidateName: string;
  jobTitle: string;
  alreadySubmitted: boolean;
  remaining: number;
  question: CodingChallenge;
}

export default function MeetingCodingPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token ?? '';

  const [data, setData] = useState<ChallengeResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<{ passed: number; total: number } | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const [mirrored, setMirrored] = useState(false);

  // The interviewer presents a read-only view of this editor into the meeting,
  // so the code is on screen for everyone as it is written. Only the text is
  // sent; nothing here can be typed into from the other side.
  useEffect(() => {
    if (!token) return;

    const socket = io(`${API_BASE}/coding`, { transports: ['websocket', 'polling'] });
    socketRef.current = socket;

    socket.on('connect', () => {
      socket.emit('join', { token }, (res: { ok?: boolean }) => setMirrored(Boolean(res?.ok)));
    });
    socket.on('disconnect', () => setMirrored(false));

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [token]);

  const publishCode = useCallback(
    (state: { code: string; language: string }) => {
      socketRef.current?.emit('code:update', { ...state, questionId: data?.question.id });
    },
    [data?.question.id],
  );

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const res = await api.get<ChallengeResponse>(`/interview/${token}/coding`);
      setData(res.data);
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'Could not load the coding exercise'));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  // The interviewer may not have reached the coding round yet, so a missing
  // exercise is a "not yet" rather than a dead end.
  useEffect(() => {
    if (!error || data) return;
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [error, data, load]);

  if (loading) {
    return (
      <Centered>
        <Spinner className="h-6 w-6" />
        <p className="mt-3 text-sm text-muted-foreground">Loading your coding exercise…</p>
      </Centered>
    );
  }

  if (error || !data) {
    return (
      <Centered>
        <Card className="max-w-md">
          <CardBody className="text-center">
            <AlertTriangle className="mx-auto h-8 w-8 text-warning" />
            <p className="mt-3 text-sm font-medium text-foreground">{error || 'No coding exercise yet'}</p>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Keep this tab open. It checks again every few seconds, and the exercise appears as soon as the
              interviewer reaches that part of the interview.
            </p>
          </CardBody>
        </Card>
      </Centered>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-muted/30">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-surface px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Code2 className="h-4 w-4" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">Coding exercise</p>
            <p className="text-xs text-muted-foreground">
              {data.candidateName} · {data.jobTitle}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {result ? (
            <Badge tone={result.passed === result.total ? 'success' : 'warning'}>
              <CheckCircle2 className="h-3.5 w-3.5" />
              Submitted · {result.passed}/{result.total} passed
            </Badge>
          ) : (
            <Badge tone="info">
              <Bot className="h-3.5 w-3.5" />
              Stay in the meeting while you work
            </Badge>
          )}

          {mirrored && (
            <Badge tone="warning" title="Your code is visible to everyone in the meeting">
              <ScreenShare className="h-3.5 w-3.5" />
              Shared on screen
            </Badge>
          )}
        </div>
      </header>

      {result && (
        <div className="px-4 pt-3">
          <Alert tone="success" title="Solution submitted">
            Go back to the meeting — the interviewer has your submission and will carry on from there.
          </Alert>
        </div>
      )}

      {data.alreadySubmitted && !result && (
        <div className="px-4 pt-3">
          <Alert tone="info" title="Already submitted">
            You have already sent a solution for this exercise. Return to the meeting.
          </Alert>
        </div>
      )}

      <div className="min-h-0 flex-1 p-4">
        <Card className="h-full overflow-hidden">
          <CodingPanel
            token={token}
            challenge={data.question}
            onCodeChange={publishCode}
            onSubmitted={(summary) => {
              setResult(summary);
              socketRef.current?.emit('code:submitted', summary);
            }}
          />
        </Card>
      </div>
    </div>
  );
}

const Centered = ({ children }: { children: React.ReactNode }) => (
  <div className="flex h-screen flex-col items-center justify-center bg-muted/30 px-4 text-center">{children}</div>
);
