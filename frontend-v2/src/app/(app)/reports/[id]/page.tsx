'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import {
  AlertTriangle,
  CheckCircle2,
  Code2,
  Download,
  FileSpreadsheet,
  Mail,
  Plug,
  ScanFace,
  Video,
} from 'lucide-react';
import { RecordingPlayer } from '@/components/interview/RecordingPlayer';
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
  ScoreBar,
  Skeleton,
  StatusBadge,
  Tabs,
  scoreTone,
} from '@/components/ui';
import { api, downloadFile, errorMessage } from '@/lib/api';
import { avatarColor, cn, formatDateTime, initials } from '@/lib/utils';

type TabId = 'overview' | 'skills' | 'coding' | 'transcript' | 'signals';

interface Report {
  id: string;
  overallRating: number;
  technicalScore: number;
  communicationScore: number;
  behavioralScore: number;
  codingScore: number | null;
  videoConfidenceScore: number | null;
  hiringRecommendation: string;
  recommendationReason: string | null;
  aiFeedback: string | null;
  candidateFeedback: string | null;
  summary: string | null;
  feedbackEmailSentAt: string | null;
  createdAt: string;
  scoresByCategory: Record<string, Array<{ label: string; value: number; evidence: string | null }>>;
  details: {
    communication?: { notes?: string[]; signals?: Record<string, number> };
    technical?: { notes?: string };
    behavioral?: { notes?: string };
    strengths?: Array<{ point: string; evidence: string }>;
    weaknesses?: Array<{ point: string; evidence: string }>;
    improvements?: string[];
    redFlags?: string[];
    skillBreakdown?: Array<{ skill: string; score: number; evidence: string }>;
    video?: {
      samples: number;
      avgFacePresence: number;
      avgGazeStability: number;
      avgMotion: number;
      dominantExpression: string;
      observations: string[];
    } | null;
    coding?: Array<{
      questionTitle: string;
      language: string;
      passedCases: number;
      totalCases: number;
      timeComplexity: string | null;
      spaceComplexity: string | null;
      qualityScore: number | null;
      feedback: string | null;
    }>;
    meta?: { durationMinutes: number | null; questionsAsked: number; identityVerified: boolean };
  };
  sessionCandidate: {
    id: string;
    status: string;
    completedAt: string | null;
    candidate: { name: string; email: string; mobile: string | null };
    interviewSession: { id: string; title: string; type: string; experienceLevel: string; skills: string[] };
    recording: { id: string; durationSeconds: number } | null;
    insights: Array<{ id: string; type: string; message: string; severity: number; createdAt: string }>;
    transcript: {
      turns: Array<{ id: string; speaker: string; text: string; round: string | null; latencyMs: number | null; timestamp: string }>;
    } | null;
  };
}

const INSIGHT_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  STRONG_ANSWER: 'success',
  HIGH_CONFIDENCE: 'success',
  HESITATION: 'warning',
  FILLER_HEAVY: 'warning',
  LONG_PAUSE: 'danger',
  LOW_CONFIDENCE: 'danger',
  UNCLEAR_RESPONSE: 'warning',
  OFF_TOPIC: 'danger',
};

export default function ReportPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();

  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabId>('overview');
  const [sending, setSending] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<Report>(`/reports/${id}`);
      setReport(res.data);
    } catch (err) {
      toast.error('Could not load the report', errorMessage(err));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <>
        <Skeleton className="mb-6 h-16" />
        <Skeleton className="h-96" />
      </>
    );
  }

  if (!report) {
    return (
      <Card>
        <CardBody>
          <Alert tone="danger" title="Report not found">
            It may have been deleted, or it belongs to another account.
          </Alert>
        </CardBody>
      </Card>
    );
  }

  const c = report.sessionCandidate.candidate;
  const session = report.sessionCandidate.interviewSession;
  const d = report.details;
  const safeName = c.name.replace(/[^a-z0-9]/gi, '_');

  const download = async (format: 'pdf' | 'xlsx') => {
    try {
      await downloadFile(`/reports/${report.id}/export.${format}`, `Interview_Report_${safeName}.${format}`);
    } catch (err) {
      toast.error('Download failed', errorMessage(err));
    }
  };

  const emailFeedback = async () => {
    const already = Boolean(report.feedbackEmailSentAt);
    if (already && !confirm('Feedback has already been emailed. Send it again?')) return;

    setSending(true);
    try {
      await api.post(`/reports/${report.id}/feedback-email`, { force: already });
      toast.success('Feedback emailed', `Sent to ${c.email}.`);
      void load();
    } catch (err) {
      toast.error('Could not send feedback', errorMessage(err));
    } finally {
      setSending(false);
    }
  };

  const syncToAts = async () => {
    setSyncing(true);
    try {
      const res = await api.post<{ results: Array<{ integration: string; ok: boolean; error: string | null }> }>(
        `/reports/${report.id}/ats-sync`,
      );
      const failed = res.data.results.filter((r) => !r.ok);
      if (failed.length) {
        toast.error(`${failed.length} integration(s) failed`, failed.map((f) => f.integration).join(', '));
      } else {
        toast.success('Pushed to your ATS', res.data.results.map((r) => r.integration).join(', '));
      }
    } catch (err) {
      toast.error('ATS sync failed', errorMessage(err));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <>
      <PageHeader
        title={c.name}
        breadcrumbs={[
          { label: 'Sessions', href: '/sessions' },
          { label: session.title, href: `/sessions/${session.id}` },
          { label: 'Report' },
        ]}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => download('pdf')}>
              <Download className="h-4 w-4" />
              PDF
            </Button>
            <Button variant="outline" size="sm" onClick={() => download('xlsx')}>
              <FileSpreadsheet className="h-4 w-4" />
              Excel
            </Button>
            <Button variant="outline" size="sm" onClick={syncToAts} loading={syncing}>
              <Plug className="h-4 w-4" />
              ATS
            </Button>
            <Button size="sm" onClick={emailFeedback} loading={sending}>
              <Mail className="h-4 w-4" />
              {report.feedbackEmailSentAt ? 'Resend feedback' : 'Email feedback'}
            </Button>
          </>
        }
      />

      {/* Summary strip */}
      <Card className="mb-5">
        <CardBody className="flex flex-wrap items-center gap-x-8 gap-y-4">
          <div className="flex items-center gap-3">
            <div
              className={cn(
                'flex h-11 w-11 items-center justify-center rounded-full text-sm font-semibold',
                avatarColor(c.name),
              )}
            >
              {initials(c.name)}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{c.email}</p>
              <p className="text-xs text-muted-foreground">
                {session.title} · {session.experienceLevel}
              </p>
            </div>
          </div>

          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-semibold tabular-nums tracking-tight">
              {report.overallRating.toFixed(1)}
            </span>
            <span className="text-sm text-muted-foreground">/ 10 overall</span>
          </div>

          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Recommendation</p>
            <StatusBadge value={report.hiringRecommendation} className="mt-1 text-sm" />
          </div>

          <div className="text-sm text-muted-foreground">
            <p>
              {report.sessionCandidate.completedAt
                ? formatDateTime(report.sessionCandidate.completedAt)
                : formatDateTime(report.createdAt)}
            </p>
            <p className="text-xs">
              {d.meta?.durationMinutes ? `${d.meta.durationMinutes} min · ` : ''}
              {d.meta?.questionsAsked ?? 0} questions
              {d.meta?.identityVerified === false ? ' · identity unconfirmed' : ''}
            </p>
          </div>
        </CardBody>
      </Card>

      {report.recommendationReason && (
        <Alert
          tone={
            report.hiringRecommendation === 'REJECT'
              ? 'danger'
              : report.hiringRecommendation === 'CONSIDER'
                ? 'warning'
                : 'success'
          }
          className="mb-5"
        >
          {report.recommendationReason}
        </Alert>
      )}

      <Tabs<TabId>
        active={tab}
        onChange={setTab}
        className="mb-5"
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'skills', label: 'Skills', count: d.skillBreakdown?.length ?? 0 },
          { id: 'coding', label: 'Coding', count: d.coding?.length ?? 0 },
          { id: 'transcript', label: 'Transcript', count: report.sessionCandidate.transcript?.turns.length ?? 0 },
          { id: 'signals', label: 'Signals', count: report.sessionCandidate.insights.length },
        ]}
      />

      {tab === 'overview' && (
        <div className="space-y-4">
          {report.summary && (
            <Card>
              <CardHeader>
                <CardTitle>Summary</CardTitle>
              </CardHeader>
              <CardBody>
                <p className="text-sm leading-relaxed text-foreground">{report.summary}</p>
              </CardBody>
            </Card>
          )}

          {/* Score breakdown */}
          <div className="grid gap-4 lg:grid-cols-3">
            {(['Communication', 'Technical', 'Behavioral'] as const).map((category) => {
              const rows = report.scoresByCategory[category] ?? [];
              const headline =
                category === 'Communication'
                  ? report.communicationScore
                  : category === 'Technical'
                    ? report.technicalScore
                    : report.behavioralScore;

              return (
                <Card key={category}>
                  <CardHeader>
                    <CardTitle>{category}</CardTitle>
                    <Badge tone={scoreTone(headline)}>{headline.toFixed(1)}</Badge>
                  </CardHeader>
                  <CardBody className="space-y-3">
                    {rows.map((row) => (
                      <ScoreBar key={row.label} label={row.label} value={row.value} />
                    ))}
                    {rows.length === 0 && <p className="text-sm text-muted-foreground">No sub-scores recorded.</p>}
                  </CardBody>
                </Card>
              );
            })}
          </div>

          {/* Extra dimensions */}
          {(report.codingScore != null || report.videoConfidenceScore != null) && (
            <div className="grid gap-4 sm:grid-cols-2">
              {report.codingScore != null && (
                <Card>
                  <CardBody className="flex items-center gap-3">
                    <Code2 className="h-5 w-5 text-primary" />
                    <div>
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">Coding</p>
                      <p className="text-xl font-semibold tabular-nums">{report.codingScore.toFixed(1)} / 10</p>
                    </div>
                  </CardBody>
                </Card>
              )}
              {report.videoConfidenceScore != null && (
                <Card>
                  <CardBody className="flex items-center gap-3">
                    <ScanFace className="h-5 w-5 text-primary" />
                    <div>
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">On-camera confidence</p>
                      <p className="text-xl font-semibold tabular-nums">
                        {report.videoConfidenceScore.toFixed(1)} / 10
                      </p>
                    </div>
                  </CardBody>
                </Card>
              )}
            </div>
          )}

          {/* Strengths & weaknesses */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-1.5">
                  <CheckCircle2 className="h-4 w-4 text-success" />
                  Strengths
                </CardTitle>
              </CardHeader>
              <CardBody>
                {d.strengths?.length ? (
                  <ul className="space-y-3">
                    {d.strengths.map((s, i) => (
                      <li key={i}>
                        <p className="text-sm font-medium text-foreground">{s.point}</p>
                        {s.evidence && <p className="mt-0.5 text-sm text-muted-foreground">{s.evidence}</p>}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">Not enough evidence to name specific strengths.</p>
                )}
              </CardBody>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-1.5">
                  <AlertTriangle className="h-4 w-4 text-warning" />
                  Weaknesses
                </CardTitle>
              </CardHeader>
              <CardBody>
                {d.weaknesses?.length ? (
                  <ul className="space-y-3">
                    {d.weaknesses.map((w, i) => (
                      <li key={i}>
                        <p className="text-sm font-medium text-foreground">{w.point}</p>
                        {w.evidence && <p className="mt-0.5 text-sm text-muted-foreground">{w.evidence}</p>}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">No notable weaknesses were recorded.</p>
                )}
              </CardBody>
            </Card>
          </div>

          {d.improvements && d.improvements.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Areas for improvement</CardTitle>
              </CardHeader>
              <CardBody>
                <ul className="space-y-1.5 text-sm text-foreground">
                  {d.improvements.map((imp, i) => (
                    <li key={i}>· {imp}</li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          )}

          {d.redFlags && d.redFlags.length > 0 && (
            <Alert tone="danger" title="Red flags">
              <ul className="mt-1 space-y-1">
                {d.redFlags.map((f, i) => (
                  <li key={i}>· {f}</li>
                ))}
              </ul>
            </Alert>
          )}

          {report.aiFeedback && (
            <Card>
              <CardHeader>
                <CardTitle>AI feedback for the hiring team</CardTitle>
              </CardHeader>
              <CardBody>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{report.aiFeedback}</p>
              </CardBody>
            </Card>
          )}

          {report.candidateFeedback && (
            <Card>
              <CardHeader>
                <CardTitle>Feedback written for the candidate</CardTitle>
                {report.feedbackEmailSentAt && (
                  <Badge tone="success">Emailed {formatDateTime(report.feedbackEmailSentAt)}</Badge>
                )}
              </CardHeader>
              <CardBody>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                  {report.candidateFeedback}
                </p>
              </CardBody>
            </Card>
          )}

          {/* Recording */}
          {report.sessionCandidate.recording && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-1.5">
                  <Video className="h-4 w-4 text-muted-foreground" />
                  Session recording
                </CardTitle>
              </CardHeader>
              <CardBody>
                <RecordingPlayer sessionCandidateId={report.sessionCandidate.id} />
              </CardBody>
            </Card>
          )}
        </div>
      )}

      {tab === 'skills' && (
        <Card>
          <CardHeader>
            <CardTitle>Skill assessment</CardTitle>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Only skills that actually came up in conversation are scored.
            </p>
          </CardHeader>
          <CardBody>
            {d.skillBreakdown?.length ? (
              <div className="space-y-5">
                {d.skillBreakdown.map((s, i) => (
                  <div key={i}>
                    <ScoreBar label={s.skill} value={s.score} />
                    {s.evidence && <p className="mt-1.5 text-sm text-muted-foreground">{s.evidence}</p>}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No individual skills were assessed — the interview may have been too short.
              </p>
            )}

            {session.skills.length > 0 && (
              <div className="mt-6 border-t border-border pt-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Skills required for the role</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {session.skills.map((s) => (
                    <Badge key={s}>{s}</Badge>
                  ))}
                </div>
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {tab === 'coding' && (
        <div className="space-y-4">
          {d.coding?.length ? (
            d.coding.map((sub, i) => (
              <Card key={i}>
                <CardHeader>
                  <div>
                    <CardTitle>{sub.questionTitle}</CardTitle>
                    <p className="mt-0.5 text-sm text-muted-foreground">{sub.language}</p>
                  </div>
                  <Badge tone={sub.passedCases === sub.totalCases ? 'success' : sub.passedCases > 0 ? 'warning' : 'danger'}>
                    {sub.passedCases} / {sub.totalCases} tests passed
                  </Badge>
                </CardHeader>
                <CardBody className="space-y-3">
                  <dl className="grid gap-4 sm:grid-cols-3">
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-muted-foreground">Time complexity</dt>
                      <dd className="mt-0.5 font-mono text-sm">{sub.timeComplexity ?? '—'}</dd>
                    </div>
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-muted-foreground">Space complexity</dt>
                      <dd className="mt-0.5 font-mono text-sm">{sub.spaceComplexity ?? '—'}</dd>
                    </div>
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-muted-foreground">Code quality</dt>
                      <dd className="mt-0.5 text-sm">{sub.qualityScore != null ? `${sub.qualityScore} / 10` : '—'}</dd>
                    </div>
                  </dl>

                  {sub.feedback && (
                    <p className="border-t border-border pt-3 text-sm leading-relaxed text-muted-foreground">
                      {sub.feedback}
                    </p>
                  )}
                </CardBody>
              </Card>
            ))
          ) : (
            <Card>
              <CardBody>
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No coding submissions for this interview.
                </p>
              </CardBody>
            </Card>
          )}
        </div>
      )}

      {tab === 'transcript' && (
        <Card>
          <CardHeader>
            <CardTitle>Full transcript</CardTitle>
          </CardHeader>
          <CardBody className="space-y-4">
            {report.sessionCandidate.transcript?.turns.length ? (
              report.sessionCandidate.transcript.turns
                .filter((t) => t.speaker !== 'SYSTEM')
                .map((turn) => (
                  <div key={turn.id} className={cn('flex', turn.speaker === 'CANDIDATE' && 'justify-end')}>
                    <div className="max-w-[80%]">
                      <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="font-medium">
                          {turn.speaker === 'AI' ? 'Interviewer' : c.name.split(' ')[0]}
                        </span>
                        {turn.round && <Badge>{turn.round}</Badge>}
                        {turn.latencyMs != null && turn.latencyMs > 4000 && (
                          <span className="text-warning">paused {(turn.latencyMs / 1000).toFixed(1)}s</span>
                        )}
                      </div>
                      <div
                        className={cn(
                          'rounded-lg px-3.5 py-2.5 text-sm leading-relaxed',
                          turn.speaker === 'AI'
                            ? 'rounded-tl-sm bg-muted text-foreground'
                            : 'rounded-tr-sm bg-primary-soft text-foreground',
                        )}
                      >
                        {turn.text}
                      </div>
                    </div>
                  </div>
                ))
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">No transcript was captured.</p>
            )}
          </CardBody>
        </Card>
      )}

      {tab === 'signals' && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Real-time signals</CardTitle>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Detected live during the interview from pause length, filler density and speaking rate.
              </p>
            </CardHeader>
            <CardBody>
              {report.sessionCandidate.insights.length ? (
                <ul className="space-y-2">
                  {report.sessionCandidate.insights.map((insight) => (
                    <li key={insight.id} className="flex items-start gap-2.5 rounded-md border border-border p-3">
                      <Badge tone={INSIGHT_TONE[insight.type] ?? 'neutral'}>
                        {insight.type.replace(/_/g, ' ').toLowerCase()}
                      </Badge>
                      <p className="flex-1 text-sm text-foreground">{insight.message}</p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  No notable signals — the candidate answered steadily throughout.
                </p>
              )}
            </CardBody>
          </Card>

          {d.communication?.signals && (
            <Card>
              <CardHeader>
                <CardTitle>Measured speech statistics</CardTitle>
              </CardHeader>
              <CardBody>
                <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  {[
                    ['Answers given', d.communication.signals.answerCount],
                    ['Total words', d.communication.signals.totalWords],
                    ['Avg words per answer', d.communication.signals.avgWordsPerAnswer],
                    ['Avg pause before answering', `${d.communication.signals.avgLatencyMs ?? 0} ms`],
                    ['Pauses over 5s', d.communication.signals.longPauses],
                    ['Filler words', d.communication.signals.fillerCount],
                    ['Speaking rate', `${d.communication.signals.avgWordsPerMinute ?? 0} wpm`],
                    [
                      'Vocabulary richness',
                      `${Math.round((d.communication.signals.vocabularyRichness ?? 0) * 100)}%`,
                    ],
                  ].map(([label, value]) => (
                    <div key={String(label)}>
                      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
                      <dd className="mt-0.5 text-sm font-medium tabular-nums">{value ?? '—'}</dd>
                    </div>
                  ))}
                </dl>

                {d.communication.notes && d.communication.notes.length > 0 && (
                  <ul className="mt-4 space-y-1 border-t border-border pt-4 text-sm text-muted-foreground">
                    {d.communication.notes.map((n, i) => (
                      <li key={i}>· {n}</li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>
          )}

          {d.video && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-1.5">
                  <ScanFace className="h-4 w-4 text-muted-foreground" />
                  On-camera presence
                </CardTitle>
                <Badge>{d.video.samples} samples</Badge>
              </CardHeader>
              <CardBody>
                <dl className="grid gap-4 sm:grid-cols-4">
                  {[
                    ['Face visible', `${Math.round(d.video.avgFacePresence * 100)}%`],
                    ['Gaze stability', `${Math.round(d.video.avgGazeStability * 100)}%`],
                    ['Movement', `${Math.round(d.video.avgMotion * 100)}%`],
                    ['Dominant expression', d.video.dominantExpression.toLowerCase()],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
                      <dd className="mt-0.5 text-sm font-medium capitalize">{value}</dd>
                    </div>
                  ))}
                </dl>

                <ul className="mt-4 space-y-1 border-t border-border pt-4 text-sm text-muted-foreground">
                  {d.video.observations.map((o, i) => (
                    <li key={i}>· {o}</li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          )}
        </div>
      )}
    </>
  );
}
