'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  FileText,
  Plus,
  UserX,
  Users,
} from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  EmptyState,
  Skeleton,
  StatusBadge,
  scoreTone,
} from '@/components/ui';
import { Button } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { avatarColor, cn, formatDateTime, initials, relativeTime } from '@/lib/utils';
import { useToast } from '@/components/Toast';

interface Overview {
  totals: { sessions: number; activeSessions: number; candidates: number; completed: number; absent: number; pending: number; inProgress: number; reports: number };
  rates: { completion: number; noShow: number; hireRate: number };
  avgScores: { overall: number; technical: number; communication: number; behavioral: number; coding: number };
}

interface Upcoming {
  id: string;
  accessToken: string;
  status: string;
  candidate: { name: string; email: string };
  interviewSession: { id: string; title: string; scheduledAt: string; durationMinutes: number };
}

interface RecentReport {
  id: string;
  overallRating: number;
  hiringRecommendation: string;
  createdAt: string;
  sessionCandidate: {
    candidate: { name: string; email: string };
    interviewSession: { id: string; title: string };
  };
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  tone = 'primary',
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | number;
  sub?: string;
  tone?: 'primary' | 'success' | 'warning' | 'danger';
}) {
  const tones = {
    primary: 'bg-primary-soft text-primary',
    success: 'bg-success-soft text-success',
    warning: 'bg-warning-soft text-warning',
    danger: 'bg-danger-soft text-danger',
  };

  return (
    <Card>
      <CardBody className="flex items-start gap-3">
        <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-md', tones[tone])}>
          <Icon className="h-4.5 w-4.5" />
        </div>
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className="mt-0.5 text-2xl font-semibold tabular-nums tracking-tight text-foreground">{value}</p>
          {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
        </div>
      </CardBody>
    </Card>
  );
}

export default function DashboardPage() {
  const toast = useToast();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [upcoming, setUpcoming] = useState<Upcoming[]>([]);
  const [reports, setReports] = useState<RecentReport[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const [o, u, r] = await Promise.all([
          api.get<Overview>('/analytics/overview'),
          api.get<Upcoming[]>('/sessions/upcoming'),
          api.get<RecentReport[]>('/reports/recent', { params: { limit: 6 } }),
        ]);
        if (cancelled) return;
        setOverview(o.data);
        setUpcoming(u.data);
        setReports(r.data);
      } catch (err) {
        if (!cancelled) toast.error('Could not load the dashboard', errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-72" />
          <Skeleton className="h-72" />
        </div>
      </>
    );
  }

  const t = overview?.totals;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Interview activity across all of your sessions."
        actions={
          <Link href="/ai-interviews/new">
            <Button>
              <Plus className="h-4 w-4" />
              New interview
            </Button>
          </Link>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={CalendarClock}
          label="Sessions"
          value={t?.sessions ?? 0}
          sub={`${t?.activeSessions ?? 0} scheduled or live`}
        />
        <StatCard
          icon={Users}
          label="Candidates"
          value={t?.candidates ?? 0}
          sub={`${t?.pending ?? 0} yet to interview`}
        />
        <StatCard
          icon={CheckCircle2}
          label="Completed"
          value={t?.completed ?? 0}
          sub={`${overview?.rates.completion ?? 0}% completion rate`}
          tone="success"
        />
        <StatCard
          icon={UserX}
          label="No-shows"
          value={t?.absent ?? 0}
          sub={`${overview?.rates.noShow ?? 0}% of invitations`}
          tone={(t?.absent ?? 0) > 0 ? 'warning' : 'primary'}
        />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        {/* Upcoming */}
        <Card>
          <CardHeader>
            <CardTitle>Upcoming interviews</CardTitle>
            <Link href="/sessions" className="text-sm font-medium text-primary hover:underline">
              All sessions
            </Link>
          </CardHeader>

          {upcoming.length === 0 ? (
            <EmptyState
              icon={CalendarClock}
              title="Nothing scheduled"
              description="Schedule an interview with a Google Meet, Zoom or Teams link to get started."
              action={
                <Link href="/ai-interviews/new">
                  <Button size="sm">
                    <Plus className="h-4 w-4" />
                    New interview
                  </Button>
                </Link>
              }
            />
          ) : (
            <ul className="divide-y divide-border">
              {upcoming.map((row) => (
                <li key={row.id}>
                  <Link
                    href={`/sessions/${row.interviewSession.id}`}
                    className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-muted/60"
                  >
                    <div
                      className={cn(
                        'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                        avatarColor(row.candidate.name),
                      )}
                    >
                      {initials(row.candidate.name)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{row.candidate.name}</p>
                      <p className="truncate text-xs text-muted-foreground">{row.interviewSession.title}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-xs font-medium text-foreground">
                        {relativeTime(row.interviewSession.scheduledAt)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatDateTime(row.interviewSession.scheduledAt)}
                      </p>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Recent reports */}
        <Card>
          <CardHeader>
            <CardTitle>Recent reports</CardTitle>
            <Link href="/reports" className="text-sm font-medium text-primary hover:underline">
              All reports
            </Link>
          </CardHeader>

          {reports.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="No reports yet"
              description="Reports appear here automatically once a candidate finishes their interview."
            />
          ) : (
            <ul className="divide-y divide-border">
              {reports.map((r) => (
                <li key={r.id}>
                  <Link href={`/reports/${r.id}`} className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-muted/60">
                    <div
                      className={cn(
                        'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                        avatarColor(r.sessionCandidate.candidate.name),
                      )}
                    >
                      {initials(r.sessionCandidate.candidate.name)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">
                        {r.sessionCandidate.candidate.name}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {r.sessionCandidate.interviewSession.title}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge tone={scoreTone(r.overallRating)}>{r.overallRating.toFixed(1)}</Badge>
                      <StatusBadge value={r.hiringRecommendation} />
                      <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
