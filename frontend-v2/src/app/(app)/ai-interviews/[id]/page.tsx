'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import {
  AlertTriangle,
  Bot,
  ExternalLink,
  FileText,
  Mic,
  Play,
  Radio,
  RefreshCw,
  Square,
  User,
} from 'lucide-react';
import { QuestionEditor } from '@/components/interviews/QuestionEditor';
import { PageHeader } from '@/components/layout/PageHeader';
import { useToast } from '@/components/Toast';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  EmptyState,
  Skeleton,
  Tabs,
} from '@/components/ui';
import { mergeTranscript, useMeetBot } from '@/hooks/useMeetBot';
import { api, errorMessage } from '@/lib/api';
import {
  canRetryReport,
  canStart,
  canStop,
  evaluationLabel,
  evaluationTone,
  statusMeta,
  type MeetBotStatus,
  type MeetInterview,
  type TranscriptMessage,
} from '@/lib/meetInterview';
import { cn, formatClock, formatDateTime, formatDuration, relativeTime } from '@/lib/utils';

/**
 * The stages a recruiter watches an interview move through.
 *
 * Not every status appears — FOLLOW_UP and INTRODUCTION are moments inside
 * "Interviewing" rather than steps of their own, and showing them as separate
 * stages would make the track jump backwards mid-interview.
 */
const STAGES: Array<{ key: string; label: string; matches: MeetBotStatus[] }> = [
  { key: 'scheduled', label: 'Scheduled', matches: ['SCHEDULED'] },
  { key: 'starting', label: 'Starting', matches: ['STARTING', 'OPENING_MEETING'] },
  { key: 'joining', label: 'Joining', matches: ['PRE_JOIN', 'WAITING_FOR_ADMISSION'] },
  { key: 'joined', label: 'Joined', matches: ['JOINED', 'WAITING_FOR_CANDIDATE'] },
  { key: 'running', label: 'Interviewing', matches: ['INTRODUCTION', 'QUESTIONING', 'FOLLOW_UP', 'FINAL_QUESTION'] },
  { key: 'done', label: 'Completed', matches: ['ENDING', 'COMPLETED'] },
];

const stageIndex = (status: MeetBotStatus) => STAGES.findIndex((s) => s.matches.includes(status));

/** Backs up the socket, so status still advances if the websocket cannot connect. */
const POLL_MS = 6_000;

type Tab = 'live' | 'questions' | 'transcript' | 'details';

export default function MeetInterviewPage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const toast = useToast();

  const interviewId = params?.id ?? null;

  const [interview, setInterview] = useState<MeetInterview | null>(null);
  const [stored, setStored] = useState<TranscriptMessage[]>([]);
  const [reportId, setReportId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>((searchParams?.get('tab') as Tab) ?? 'live');

  const live = useMeetBot(interviewId, Boolean(interview));

  // The socket is the fresher source once it has said anything; before that the
  // stored status is all there is.
  const status: MeetBotStatus = live.status ?? interview?.status ?? 'SCHEDULED';
  const meta = statusMeta(status);
  const detail = live.detail ?? interview?.statusDetail ?? null;

  const loadInterview = useCallback(async () => {
    if (!interviewId) return;
    const { data } = await api.get<MeetInterview>(`/interviews/${interviewId}`);
    setInterview(data);
    return data;
  }, [interviewId]);

  const loadTranscript = useCallback(async () => {
    if (!interviewId) return;
    const { data } = await api.get<{ messages: TranscriptMessage[] }>(`/interviews/${interviewId}/transcript`);
    setStored(data.messages);
  }, [interviewId]);

  const loadReport = useCallback(async () => {
    if (!interviewId) return;
    try {
      const { data } = await api.get<{ reportId: string }>(`/interviews/${interviewId}/report`);
      setReportId(data.reportId);
    } catch {
      // No report yet is the normal case for anything not finished.
      setReportId(null);
    }
  }, [interviewId]);

  useEffect(() => {
    if (!interviewId) return;

    void (async () => {
      try {
        await Promise.all([loadInterview(), loadTranscript(), loadReport()]);
      } catch (err) {
        toast.error('Could not load the interview', errorMessage(err));
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interviewId]);

  // Poll while live. Cheap, and the only thing keeping the page honest if the
  // websocket is blocked by a proxy.
  useEffect(() => {
    if (!meta.live) return;
    const timer = setInterval(() => void loadInterview().catch(() => {}), POLL_MS);
    return () => clearInterval(timer);
  }, [meta.live, loadInterview]);

  // Pull the finished transcript and report once the interview ends.
  const wasLive = useRef(false);
  useEffect(() => {
    if (meta.live) {
      wasLive.current = true;
      return;
    }
    if (!wasLive.current) return;
    wasLive.current = false;

    void loadTranscript().catch(() => {});
    // Evaluation runs after the meeting closes, so give it a moment.
    const timer = setTimeout(() => void loadReport().catch(() => {}), 8_000);
    return () => clearTimeout(timer);
  }, [meta.live, loadTranscript, loadReport]);

  const act = async (action: 'start' | 'stop') => {
    if (!interviewId) return;
    setBusy(true);
    try {
      const { data } = await api.post<MeetInterview>(`/interviews/${interviewId}/${action}`);
      setInterview(data);
      toast.success(action === 'start' ? 'Interviewer starting' : 'Interview stopped');
    } catch (err) {
      toast.error(action === 'start' ? 'Could not start' : 'Could not stop', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const messages = useMemo(() => mergeTranscript(stored, live.messages), [stored, live.messages]);

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!interview) {
    return (
      <Card>
        <EmptyState icon={AlertTriangle} title="Interview not found" />
      </Card>
    );
  }

  return (
    <div>
      <PageHeader
        title={interview.candidateName}
        description={`${interview.jobTitle} · ${formatDateTime(interview.scheduledAt)} · ${formatDuration(interview.durationMinutes)}`}
        breadcrumbs={[{ label: 'AI interviews', href: '/ai-interviews' }, { label: interview.candidateName }]}
        actions={
          <>
            {interview.meetLink && (
              <a href={interview.meetLink} target="_blank" rel="noreferrer">
                <Button variant="outline" size="sm">
                  <ExternalLink className="h-4 w-4" />
                  Open {interview.platformLabel}
                </Button>
              </a>
            )}
            {reportId && (
              <Link href={`/reports/${reportId}`}>
                <Button variant="outline" size="sm">
                  <FileText className="h-4 w-4" />
                  Report
                </Button>
              </Link>
            )}
            {canStart(status) && (
              <Button size="sm" loading={busy} onClick={() => void act('start')}>
                <Play className="h-4 w-4" />
                {status === 'SCHEDULED' ? 'Start now' : 'Retry'}
              </Button>
            )}
            {canStop(status) && (
              <Button size="sm" variant="danger" loading={busy} onClick={() => void act('stop')}>
                <Square className="h-4 w-4" />
                Stop
              </Button>
            )}
          </>
        }
      />

      <StatusPanel
        interview={interview}
        status={status}
        detail={detail}
        connected={live.connected}
        questionCount={live.questionCount}
      />

      {status === 'FAILED' && interview.errorMessage && (
        <Alert tone="danger" title="This interview failed" className="mt-4">
          {interview.errorMessage}
          {interview.errorCode && (
            <span className="ml-1 font-mono text-xs opacity-70">({interview.errorCode})</span>
          )}
        </Alert>
      )}

      {!meta.live && interview.candidateStatus !== 'INVITED' && (
        <ReportStatus interview={interview} onRetry={async () => setInterview(await retryReport(interview.id))} />
      )}

      {interview.codingUrlReachable === false && (
        <Alert tone="danger" title="The coding editor is not reachable" className="mt-4">
          <p>
            <span className="font-mono text-xs">{interview.codingUrl}</span> returns a 404, so the candidate cannot
            open it.
          </p>
          <p className="mt-1.5">
            The backend builds this link from <span className="font-mono text-xs">APP_URL</span>, but the page is
            served by the frontend. Either point <span className="font-mono text-xs">APP_URL</span> at a frontend
            that has it (<span className="font-mono text-xs">http://localhost:3000</span> when testing locally), or
            deploy the current build. The interviewer skips the coding round rather than handing out a dead link.
          </p>
        </Alert>
      )}

      {status === 'CANCELLED' && detail && (
        <Alert tone="warning" title="This interview did not run" className="mt-4">
          {detail}
        </Alert>
      )}

      {status === 'WAITING_FOR_CANDIDATE' && detail && (
        <Alert tone="info" title="Waiting for the candidate" className="mt-4">
          {detail}
        </Alert>
      )}

      {status === 'WAITING_FOR_ADMISSION' && (
        <Alert tone="warning" title="Waiting for organizer approval" className="mt-4">
          The AI interviewer has asked to join and is in the {interview.platformLabel} lobby. Someone already in the
          meeting needs to admit it.
        </Alert>
      )}

      <div className="mt-5">
        <Tabs
          tabs={[
            { id: 'live' as const, label: 'Live' },
            { id: 'questions' as const, label: 'Questions' },
            { id: 'transcript' as const, label: 'Transcript', count: messages.length },
            { id: 'details' as const, label: 'Details' },
          ]}
          active={tab}
          onChange={setTab}
        />

        <div className="pt-4">
          {tab === 'live' && (
            <LiveConversation messages={messages} interim={live.interim} status={status} detail={detail} />
          )}
          {tab === 'questions' && (
            <QuestionEditor
              sessionId={interview.sessionId}
              // The bot's own status is the honest signal here. `SCHEDULED` and
              // `FAILED` both mean nothing was ever asked, so a failed run can
              // still be corrected and retried.
              editable={status === 'SCHEDULED' || status === 'FAILED'}
            />
          )}
          {tab === 'transcript' && <Transcript messages={messages} onRefresh={() => void loadTranscript()} />}
          {tab === 'details' && <Details interview={interview} reportId={reportId} />}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function StatusPanel({
  interview,
  status,
  detail,
  connected,
  questionCount,
}: {
  interview: MeetInterview;
  status: MeetBotStatus;
  detail: string | null;
  connected: boolean;
  questionCount: number;
}) {
  const meta = statusMeta(status);
  const current = stageIndex(status);

  // Ticks locally rather than re-fetching every second.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!meta.live) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [meta.live]);

  const elapsed = interview.joinedAt
    ? Math.max(0, Math.floor(((interview.endedAt ? new Date(interview.endedAt).getTime() : now) - new Date(interview.joinedAt).getTime()) / 1000))
    : 0;

  /**
   * Getting a browser into a meeting takes the better part of a minute, and a
   * panel that just says "Starting" for that long reads as broken — three
   * interviews in a row were stopped by hand seconds before the bot got in.
   * So say what is happening and show the clock running.
   */
  const joining = ['STARTING', 'OPENING_MEETING', 'PRE_JOIN'].includes(status);
  const joiningSeconds = joining && interview.startedAt
    ? Math.max(0, Math.floor((now - new Date(interview.startedAt).getTime()) / 1000))
    : 0;

  return (
    <Card>
      <CardBody className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-md',
                meta.live ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
              )}
            >
              <Bot className="h-4 w-4" />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">AI Interviewer</p>
              <p className="text-xs text-muted-foreground">{detail ?? meta.label}</p>
              {joining && (
                <p className="mt-0.5 text-xs font-medium text-primary">
                  Opening the meeting — this takes about a minute
                  {joiningSeconds > 0 && ` · ${joiningSeconds}s`}
                </p>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <Stat label="Status">
              <Badge tone={meta.tone}>
                <span className={cn('h-1.5 w-1.5 rounded-full bg-current', meta.live && 'animate-pulse')} />
                {meta.live ? 'LIVE' : meta.label}
              </Badge>
            </Stat>

            <Stat label="Candidate">
              <span className="text-sm font-medium text-foreground">{interview.candidateName}</span>
            </Stat>

            <Stat label="Duration">
              <span className="font-mono text-sm tabular-nums text-foreground">
                {interview.joinedAt ? formatClock(elapsed) : '—'}
              </span>
            </Stat>

            {questionCount > 0 && (
              <Stat label="Questions">
                <span className="font-mono text-sm tabular-nums text-foreground">{questionCount}</span>
              </Stat>
            )}

            {meta.live && (
              <Stat label="Feed">
                <span
                  className={cn(
                    'inline-flex items-center gap-1 text-xs font-medium',
                    connected ? 'text-emerald-600' : 'text-amber-600',
                  )}
                >
                  <Radio className={cn('h-3 w-3', connected && 'animate-pulse')} />
                  {connected ? 'Connected' : 'Reconnecting'}
                </span>
              </Stat>
            )}
          </div>
        </div>

        <ol className="flex flex-wrap items-center gap-x-1 gap-y-2">
          {STAGES.map((stage, i) => {
            const done = current > i || status === 'COMPLETED';
            const active = current === i;
            const failed = (status === 'FAILED' || status === 'CANCELLED') && i === Math.max(current, 0);

            return (
              <li key={stage.key} className="flex items-center gap-1">
                <span
                  className={cn(
                    'whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors',
                    failed
                      ? 'bg-danger-soft text-danger'
                      : active
                        ? 'bg-primary text-primary-foreground'
                        : done
                          ? 'bg-success-soft text-success'
                          : 'bg-muted text-muted-foreground',
                  )}
                >
                  {stage.label}
                </span>
                {i < STAGES.length - 1 && (
                  <span className={cn('h-px w-4', done ? 'bg-success/50' : 'bg-border')} aria-hidden />
                )}
              </li>
            );
          })}
        </ol>
      </CardBody>
    </Card>
  );
}

async function retryReport(interviewId: string): Promise<MeetInterview> {
  await api.post(`/interviews/${interviewId}/report/retry`);
  const { data } = await api.get<MeetInterview>(`/interviews/${interviewId}`);
  return data;
}

/**
 * Why there is, or is not, a report.
 *
 * "No report" on its own is useless: it covers a candidate who never showed up,
 * an interview that finished a minute ago, and a provider quota that clears in
 * twenty minutes. Each needs a different reaction, so each says so.
 */
function ReportStatus({ interview, onRetry }: { interview: MeetInterview; onRetry: () => Promise<void> }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const evaluation = interview.evaluation;

  if (!evaluation || evaluation.state === 'NOT_INTERVIEWED') return null;

  const retry = async () => {
    setBusy(true);
    try {
      await onRetry();
      toast.success('Report attempt started');
    } catch (err) {
      toast.error('Could not generate the report', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const tone = evaluationTone(evaluation.state);

  return (
    <Card className="mt-4">
      <CardBody className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={tone}>{evaluationLabel(evaluation.state)}</Badge>
            {evaluation.transcriptTurns > 0 && (
              <span className="text-xs text-muted-foreground">{evaluation.transcriptTurns} turns recorded</span>
            )}
          </div>

          <p className="mt-1.5 text-sm text-foreground">{evaluation.explanation}</p>

          {evaluation.error && (
            <p className="mt-1 text-xs text-muted-foreground">
              Last error: <span className="font-mono">{evaluation.error}</span>
            </p>
          )}

          {evaluation.nextRetryAt && (
            <p className="mt-1 text-xs text-muted-foreground">
              Next automatic attempt {relativeTime(evaluation.nextRetryAt)}.
            </p>
          )}
        </div>

        <div className="flex shrink-0 gap-2">
          {evaluation.reportId && (
            <Link href={`/reports/${evaluation.reportId}`}>
              <Button size="sm" variant="outline">
                <FileText className="h-4 w-4" />
                View report
              </Button>
            </Link>
          )}
          {canRetryReport(evaluation.state) && (
            <Button size="sm" variant="outline" loading={busy} onClick={() => void retry()}>
              <RefreshCw className="h-4 w-4" />
              Retry now
            </Button>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

const Stat = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="min-w-[70px]">
    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
    <div className="mt-0.5">{children}</div>
  </div>
);

// ---------------------------------------------------------------------------

function LiveConversation({
  messages,
  interim,
  status,
  detail,
}: {
  messages: TranscriptMessage[];
  interim: string;
  status: MeetBotStatus;
  detail: string | null;
}) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, interim]);

  const meta = statusMeta(status);

  if (!messages.length && !meta.live) {
    return (
      <Card>
        <EmptyState
          icon={Mic}
          title="The interview has not started"
          description={detail ?? 'The conversation appears here as it happens.'}
        />
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Conversation</CardTitle>
        {meta.live && (
          <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600">
            <Radio className="h-3 w-3 animate-pulse" />
            Live
          </span>
        )}
      </CardHeader>
      <CardBody className="scroll-area max-h-[520px] space-y-3 overflow-y-auto">
        {messages.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">{detail ?? 'Waiting for the first question…'}</p>
        )}

        {messages.map((message) => (
          <Turn key={message.id} message={message} />
        ))}

        {interim && (
          <div className="flex gap-2.5 opacity-60">
            <Avatar speaker="CANDIDATE" />
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Candidate · speaking
              </p>
              <p className="mt-0.5 text-sm italic leading-relaxed text-foreground">{interim}</p>
            </div>
          </div>
        )}

        <div ref={endRef} />
      </CardBody>
    </Card>
  );
}

function Transcript({ messages, onRefresh }: { messages: TranscriptMessage[]; onRefresh: () => void }) {
  if (!messages.length) {
    return (
      <Card>
        <EmptyState
          icon={Mic}
          title="No transcript yet"
          description="Every turn is written down as it is spoken, so this fills in while the interview runs."
          action={
            <Button variant="outline" size="sm" onClick={onRefresh}>
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>
          }
        />
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Transcript</CardTitle>
        <Button variant="ghost" size="sm" onClick={onRefresh}>
          <RefreshCw className="h-4 w-4" />
          Refresh
        </Button>
      </CardHeader>
      <CardBody className="space-y-3">
        {messages.map((message) => (
          <Turn key={message.id} message={message} showTime />
        ))}
      </CardBody>
    </Card>
  );
}

function Turn({ message, showTime }: { message: TranscriptMessage; showTime?: boolean }) {
  const isAi = message.speaker === 'AI';

  return (
    <div className="flex gap-2.5">
      <Avatar speaker={message.speaker} />
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {isAi ? 'AI interviewer' : message.speaker === 'CANDIDATE' ? 'Candidate' : 'System'}
          {message.questionNumber ? ` · question ${message.questionNumber}` : ''}
          {showTime ? ` · ${new Date(message.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : ''}
        </p>
        <p
          className={cn(
            'mt-0.5 whitespace-pre-wrap text-sm leading-relaxed',
            isAi ? 'text-foreground' : 'text-muted-foreground',
          )}
        >
          {message.message}
        </p>
      </div>
    </div>
  );
}

const Avatar = ({ speaker }: { speaker: TranscriptMessage['speaker'] }) => (
  <div
    className={cn(
      'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
      speaker === 'AI' ? 'bg-primary-soft text-primary' : 'bg-muted text-muted-foreground',
    )}
  >
    {speaker === 'AI' ? <Bot className="h-3.5 w-3.5" /> : <User className="h-3.5 w-3.5" />}
  </div>
);

// ---------------------------------------------------------------------------

function Details({ interview, reportId }: { interview: MeetInterview; reportId: string | null }) {
  const rows: Array<[string, React.ReactNode]> = [
    ['Candidate', `${interview.candidateName} · ${interview.candidateEmail}`],
    ['Role', interview.jobTitle],
    ['Skills', interview.requiredSkills.join(', ') || '—'],
    ['Scheduled', formatDateTime(interview.scheduledAt)],
    ['Duration', formatDuration(interview.durationMinutes)],
    ['Platform', interview.platformLabel],
    [
      'Meeting link',
      interview.meetLink ? (
        <a href={interview.meetLink} target="_blank" rel="noreferrer" className="text-primary hover:underline">
          {interview.meetLink}
        </a>
      ) : (
        '—'
      ),
    ],
    [
      'Coding editor',
      interview.codingUrl ? (
        <span className="flex flex-wrap items-center gap-2">
          <a
            href={interview.codingUrl}
            target="_blank"
            rel="noreferrer"
            className="break-all font-mono text-xs text-primary hover:underline"
          >
            {interview.codingUrl}
          </a>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void navigator.clipboard.writeText(interview.codingUrl!)}
          >
            Copy
          </Button>
        </span>
      ) : (
        'No coding round in this interview'
      ),
    ],
    ['Interviewer joins at', interview.joinAt ? formatDateTime(interview.joinAt) : '—'],
    ['Joined the meeting', interview.joinedAt ? formatDateTime(interview.joinedAt) : 'Not yet'],
    ['Ended', interview.endedAt ? formatDateTime(interview.endedAt) : '—'],
    ['Attempts', String(interview.attempts)],
    ['Candidate record', interview.candidateStatus],
    [
      'Report',
      reportId ? (
        <Link href={`/reports/${reportId}`} className="text-primary hover:underline">
          View full report
        </Link>
      ) : (
        'Generated once the interview finishes'
      ),
    ],
  ];

  return (
    <Card>
      <CardBody>
        <dl className="divide-y divide-border">
          {rows.map(([label, value]) => (
            <div key={label} className="grid grid-cols-1 gap-1 py-2.5 sm:grid-cols-[190px_1fr] sm:gap-4">
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
              <dd className="min-w-0 break-words text-sm text-foreground">{value}</dd>
            </div>
          ))}
        </dl>

        <div className="mt-4 border-t border-border pt-4">
          <p className="text-xs text-muted-foreground">
            The job description used to generate the questions:
          </p>
          <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
            {interview.jobDescription}
          </p>
        </div>
      </CardBody>
    </Card>
  );
}
