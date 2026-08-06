'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { BarChart3 } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { useToast } from '@/components/Toast';
import { BarList, ChartFrame, StatTile, TimeSeries, VIZ } from '@/components/charts';
import { Card, CardBody, EmptyState, Skeleton, StatusBadge, humanise } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/utils';

interface Overview {
  totals: { sessions: number; activeSessions: number; candidates: number; completed: number; absent: number; pending: number; inProgress: number; reports: number };
  rates: { completion: number; noShow: number; hireRate: number };
  avgScores: { overall: number; technical: number; communication: number; behavioral: number; coding: number };
  recommendationDistribution: Record<string, number>;
  activity: Array<{ date: string; invited: number; completed: number }>;
}

interface SkillAnalytics {
  skills: Array<{ skill: string; average: number; assessed: number }>;
  strongest: Array<{ skill: string; average: number; assessed: number }>;
  weakest: Array<{ skill: string; average: number; assessed: number }>;
}

interface SessionAnalytics {
  id: string;
  title: string;
  type: string;
  status: string;
  scheduledAt: string;
  candidates: number;
  completed: number;
  absent: number;
  evaluated: number;
  avgOverall: number;
  hires: number;
}

/** Strongest recommendation first, matching the ordinal ramp dark → light. */
const RECOMMENDATION_ORDER = ['STRONG_HIRE', 'HIRE', 'CONSIDER', 'REJECT'];

export default function AnalyticsPage() {
  const toast = useToast();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [skills, setSkills] = useState<SkillAnalytics | null>(null);
  const [sessions, setSessions] = useState<SessionAnalytics[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [o, s, ses] = await Promise.all([
          api.get<Overview>('/analytics/overview'),
          api.get<SkillAnalytics>('/analytics/skills'),
          api.get<SessionAnalytics[]>('/analytics/sessions'),
        ]);
        setOverview(o.data);
        setSkills(s.data);
        setSessions(ses.data);
      } catch (err) {
        toast.error('Could not load analytics', errorMessage(err));
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return (
      <>
        <PageHeader title="Analytics" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <Skeleton className="mt-4 h-72" />
      </>
    );
  }

  if (!overview || overview.totals.candidates === 0) {
    return (
      <>
        <PageHeader title="Analytics" />
        <Card>
          <EmptyState
            icon={BarChart3}
            title="Nothing to analyse yet"
            description="Once candidates have completed interviews, hiring trends and skill breakdowns appear here."
            action={
              <Link href="/sessions/new" className="text-sm font-medium text-primary hover:underline">
                Create a session
              </Link>
            }
          />
        </Card>
      </>
    );
  }

  const totalRecommendations = RECOMMENDATION_ORDER.reduce(
    (sum, key) => sum + (overview.recommendationDistribution[key] ?? 0),
    0,
  );

  const recommendationBars = RECOMMENDATION_ORDER.map((key, i) => ({
    label: humanise(key),
    value: overview.recommendationDistribution[key] ?? 0,
    color: VIZ.ordinal[i],
    note: totalRecommendations
      ? `(${Math.round(((overview.recommendationDistribution[key] ?? 0) / totalRecommendations) * 100)}%)`
      : undefined,
  }));

  const scoreBars = [
    { label: 'Overall', value: overview.avgScores.overall },
    { label: 'Technical', value: overview.avgScores.technical },
    { label: 'Communication', value: overview.avgScores.communication },
    { label: 'Behavioral', value: overview.avgScores.behavioral },
    ...(overview.avgScores.coding > 0 ? [{ label: 'Coding', value: overview.avgScores.coding }] : []),
  ];

  return (
    <>
      <PageHeader title="Analytics" description="Hiring trends across every session you own." />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Interviews completed"
          value={overview.totals.completed}
          sub={`${overview.rates.completion}% of everyone invited`}
        />
        <StatTile
          label="No-show rate"
          value={`${overview.rates.noShow}%`}
          sub={`${overview.totals.absent} candidates never joined`}
        />
        <StatTile
          label="Hire rate"
          value={`${overview.rates.hireRate}%`}
          sub={`of ${overview.totals.reports} evaluated candidates`}
        />
        <StatTile
          label="Average overall score"
          value={overview.avgScores.overall.toFixed(1)}
          sub="out of 10"
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <ChartFrame
          title="Activity over the last 14 days"
          description="Candidates invited against interviews completed."
          legend={[
            { label: 'Invited', color: VIZ.series[0] },
            { label: 'Completed', color: VIZ.series[1] },
          ]}
        >
          <TimeSeries
            data={overview.activity}
            series={[
              { key: 'invited', label: 'Invited', color: VIZ.series[0] },
              { key: 'completed', label: 'Completed', color: VIZ.series[1] },
            ]}
          />
        </ChartFrame>

        <ChartFrame
          title="Hiring recommendations"
          description={
            totalRecommendations
              ? `Across ${totalRecommendations} evaluated candidate${totalRecommendations === 1 ? '' : 's'}.`
              : 'No candidates have been evaluated yet.'
          }
        >
          <BarList data={recommendationBars} max={Math.max(totalRecommendations, 1)} emptyMessage="No evaluations yet." />
        </ChartFrame>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <ChartFrame title="Average scores by dimension" description="Mean across all evaluated candidates, out of 10.">
          <BarList data={scoreBars} max={10} format={(v) => v.toFixed(1)} />
        </ChartFrame>

        <ChartFrame
          title="Skill performance"
          description={
            skills?.skills.length
              ? 'Where your candidate pool is strong and where it is thin.'
              : 'Skill scores appear once interviews cover named skills.'
          }
        >
          {skills?.skills.length ? (
            <div className="space-y-5">
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Strongest</p>
                <BarList
                  data={skills.strongest.map((s) => ({
                    label: s.skill,
                    value: s.average,
                    note: `· ${s.assessed}`,
                  }))}
                  max={10}
                  format={(v) => v.toFixed(1)}
                />
              </div>

              {skills.skills.length > 5 && (
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Weakest</p>
                  <BarList
                    data={skills.weakest.map((s) => ({
                      label: s.skill,
                      value: s.average,
                      note: `· ${s.assessed}`,
                    }))}
                    max={10}
                    format={(v) => v.toFixed(1)}
                    color={VIZ.series[1]}
                  />
                </div>
              )}

              <p className="text-xs text-muted-foreground">
                The number after each score is how many candidates were assessed on that skill.
              </p>
            </div>
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No skill-level scores yet.
            </p>
          )}
        </ChartFrame>
      </div>

      {/* Per-session table */}
      <Card className="mt-4">
        <div className="border-b border-border px-5 py-4">
          <h3 className="text-sm font-semibold">Sessions</h3>
          <p className="mt-0.5 text-sm text-muted-foreground">The same figures as a table, for scanning and export.</p>
        </div>

        {sessions.length === 0 ? (
          <CardBody>
            <p className="py-4 text-center text-sm text-muted-foreground">No sessions yet.</p>
          </CardBody>
        ) : (
          <div className="overflow-guard">
            <table className="w-full min-w-[46rem] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2.5 pl-5 font-medium">Session</th>
                  <th className="py-2.5 font-medium">Date</th>
                  <th className="py-2.5 text-right font-medium">Invited</th>
                  <th className="py-2.5 text-right font-medium">Completed</th>
                  <th className="py-2.5 text-right font-medium">No-shows</th>
                  <th className="py-2.5 text-right font-medium">Avg score</th>
                  <th className="py-2.5 pr-5 text-right font-medium">Hires</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {sessions.map((s) => (
                  <tr key={s.id} className="transition-colors hover:bg-muted/50">
                    <td className="py-3 pl-5">
                      <Link href={`/sessions/${s.id}`} className="font-medium text-foreground hover:text-primary">
                        {s.title}
                      </Link>
                      <div className="mt-1 flex gap-1.5">
                        <StatusBadge value={s.type} />
                        <StatusBadge value={s.status} />
                      </div>
                    </td>
                    <td className="py-3 text-xs text-muted-foreground">{formatDate(s.scheduledAt)}</td>
                    <td className="py-3 text-right tabular-nums">{s.candidates}</td>
                    <td className="py-3 text-right tabular-nums">{s.completed}</td>
                    <td className="py-3 text-right tabular-nums">{s.absent}</td>
                    <td className="py-3 text-right tabular-nums">{s.evaluated ? s.avgOverall.toFixed(1) : '—'}</td>
                    <td className="py-3 pr-5 text-right tabular-nums">{s.hires}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
