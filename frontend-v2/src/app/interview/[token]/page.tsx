'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { CalendarClock, CheckCircle2, XCircle } from 'lucide-react';
import { LiveRoom } from '@/components/interview/LiveRoom';
import { DeviceChoice, PreCheckScreen } from '@/components/interview/PreCheckScreen';
import { Card, CardBody, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';

interface InterviewContext {
  sessionCandidateId: string;
  candidate: { name: string; email: string };
  status: string;
  session: {
    title: string;
    type: string;
    experienceLevel: string;
    durationMinutes: number;
    scheduledAt: string;
    language: string;
    codingEnabled: boolean;
    videoAnalysisEnabled: boolean;
    recordingEnabled: boolean;
    skills: string[];
  };
  interviewer: { name: string; style: string };
  gate: {
    canJoin: boolean;
    verdict: 'OPEN' | 'TOO_EARLY' | 'EXPIRED' | 'ALREADY_COMPLETED' | 'MARKED_ABSENT' | 'CANCELLED';
    opensAt: string;
    expiresAt: string;
    reason: string | null;
  };
}

/** Live countdown to the moment the room opens. */
function Countdown({ target, onReached }: { target: string; onReached: () => void }) {
  const [remaining, setRemaining] = useState(() => new Date(target).getTime() - Date.now());

  useEffect(() => {
    const timer = setInterval(() => {
      const left = new Date(target).getTime() - Date.now();
      setRemaining(left);
      if (left <= 0) onReached();
    }, 1000);

    return () => clearInterval(timer);
  }, [target, onReached]);

  if (remaining <= 0) return <span className="font-mono text-lg text-foreground">opening…</span>;

  const total = Math.floor(remaining / 1000);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  const pad = (n: number) => String(n).padStart(2, '0');

  return (
    <span className="font-mono text-2xl font-semibold tabular-nums text-foreground">
      {days > 0 && `${days}d `}
      {pad(hours)}:{pad(minutes)}:{pad(seconds)}
    </span>
  );
}

function Notice({
  icon: Icon,
  tone,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  tone: 'success' | 'danger' | 'info';
  title: string;
  children: React.ReactNode;
}) {
  const tones = {
    success: 'bg-success-soft text-success',
    danger: 'bg-danger-soft text-danger',
    info: 'bg-primary-soft text-primary',
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-md">
        <CardBody className="text-center">
          <div className={`mx-auto flex h-11 w-11 items-center justify-center rounded-full ${tones[tone]}`}>
            <Icon className="h-5 w-5" />
          </div>
          <h1 className="mt-4 text-lg font-semibold">{title}</h1>
          <div className="mt-1.5 text-sm text-muted-foreground">{children}</div>
        </CardBody>
      </Card>
    </div>
  );
}

export default function InterviewPage() {
  const { token } = useParams<{ token: string }>();

  const [context, setContext] = useState<InterviewContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [devices, setDevices] = useState<DeviceChoice | null>(null);
  const [finished, setFinished] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await api.get<InterviewContext>(`/interview/${token}`);
      setContext(res.data);
    } catch (err) {
      setError(errorMessage(err, 'This interview link is not valid.'));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // While waiting for the room to open, re-check periodically. The countdown
  // triggers an immediate refresh at zero; this covers a device clock that runs
  // slow and would otherwise never reach it.
  useEffect(() => {
    if (!context || context.gate.canJoin || context.gate.verdict !== 'TOO_EARLY') return;

    const timer = setInterval(() => void refresh(), 20_000);
    return () => clearInterval(timer);
  }, [context, refresh]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  if (error || !context) {
    return (
      <Notice icon={XCircle} tone="danger" title="Interview not found">
        {error || 'Please check the link in your invitation email, or contact the recruiter.'}
      </Notice>
    );
  }

  if (finished || context.status === 'COMPLETED') {
    return (
      <Notice icon={CheckCircle2} tone="success" title="Interview complete">
        Thank you, {context.candidate.name.split(' ')[0]}. Your responses have been recorded and the hiring team will be
        in touch. You can close this window.
      </Notice>
    );
  }

  if (!context.gate.canJoin) {
    const { verdict, reason, opensAt } = context.gate;

    // The link is dead: nothing the candidate can do but contact the recruiter.
    if (verdict === 'EXPIRED' || verdict === 'MARKED_ABSENT' || verdict === 'CANCELLED') {
      return (
        <Notice icon={XCircle} tone="danger" title={verdict === 'CANCELLED' ? 'Interview cancelled' : 'This link has expired'}>
          <p>{reason}</p>
          <p className="mt-3 font-medium text-foreground">{context.session.title}</p>
          <p>Was scheduled for {formatDateTime(context.session.scheduledAt)}</p>
        </Notice>
      );
    }

    // Too early: hold the candidate here and open the room automatically.
    return (
      <Notice icon={CalendarClock} tone="info" title="Your interview has not started yet">
        <p className="mt-3 font-medium text-foreground">{context.session.title}</p>
        <p>Starts at {formatDateTime(context.session.scheduledAt)}</p>

        <div className="my-5 rounded-md border border-border bg-muted/50 py-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Opens in</p>
          <div className="mt-1">
            <Countdown target={opensAt} onReached={refresh} />
          </div>
        </div>

        <p className="text-xs">
          Keep this page open — it will let you in automatically. The link stops working{' '}
          {context.gate.expiresAt ? `at ${formatDateTime(context.gate.expiresAt)}` : 'shortly after the start time'}, so
          please be on time.
        </p>
      </Notice>
    );
  }

  if (!devices) {
    return (
      <PreCheckScreen
        candidateName={context.candidate.name}
        sessionTitle={context.session.title}
        interviewerName={context.interviewer.name}
        durationMinutes={context.session.durationMinutes}
        videoRequired={context.session.videoAnalysisEnabled || context.session.recordingEnabled}
        recordingEnabled={context.session.recordingEnabled}
        token={token}
        onReady={setDevices}
      />
    );
  }

  return (
    <LiveRoom
      token={token}
      devices={devices}
      candidateName={context.candidate.name}
      interviewerName={context.interviewer.name}
      sessionTitle={context.session.title}
      language={context.session.language}
      durationMinutes={context.session.durationMinutes}
      videoAnalysisEnabled={context.session.videoAnalysisEnabled}
      recordingEnabled={context.session.recordingEnabled}
      onFinished={() => setFinished(true)}
    />
  );
}
