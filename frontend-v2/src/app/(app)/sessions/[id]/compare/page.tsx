'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Users } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { useToast } from '@/components/Toast';
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ScoreBar,
  Skeleton,
  StatusBadge,
  scoreTone,
} from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { avatarColor, cn, initials } from '@/lib/utils';

interface Comparison {
  sessionCandidateId: string;
  name: string;
  email: string;
  status: string;
  report: {
    id: string;
    overallRating: number;
    technicalScore: number;
    communicationScore: number;
    behavioralScore: number;
    codingScore: number | null;
    hiringRecommendation: string;
    recommendationReason: string | null;
    summary: string | null;
    details: {
      strengths?: Array<{ point: string }>;
      weaknesses?: Array<{ point: string }>;
    };
  } | null;
  scoresByCategory: Record<string, Array<{ label: string; value: number }>>;
}

/** Highlights the best value in each row so differences are obvious at a glance. */
function bestIndex(values: Array<number | null>): number {
  let best = -1;
  let bestValue = -Infinity;
  values.forEach((v, i) => {
    if (v != null && v > bestValue) {
      bestValue = v;
      best = i;
    }
  });
  return best;
}

export default function ComparePage() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const toast = useToast();

  const [rows, setRows] = useState<Comparison[]>([]);
  const [loading, setLoading] = useState(true);

  const ids = (params.get('ids') ?? '').split(',').filter(Boolean);

  useEffect(() => {
    if (ids.length < 2) {
      setLoading(false);
      return;
    }

    api
      .post<Comparison[]>('/sessions/compare', { sessionCandidateIds: ids })
      .then((res) => setRows(res.data))
      .catch((err) => toast.error('Could not load the comparison', errorMessage(err)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.get('ids')]);

  if (loading) {
    return (
      <>
        <Skeleton className="mb-6 h-16" />
        <Skeleton className="h-96" />
      </>
    );
  }

  if (rows.length < 2) {
    return (
      <>
        <PageHeader
          title="Compare candidates"
          breadcrumbs={[{ label: 'Sessions', href: '/sessions' }, { label: 'Compare' }]}
        />
        <Card>
          <EmptyState
            icon={Users}
            title="Pick at least two candidates"
            description="Go to the session's Results tab, tick two or more evaluated candidates, then choose Compare."
            action={
              <Link href={`/sessions/${id}`}>
                <Button size="sm">Back to session</Button>
              </Link>
            }
          />
        </Card>
      </>
    );
  }

  const metrics: Array<{ label: string; get: (r: Comparison) => number | null }> = [
    { label: 'Overall', get: (r) => r.report?.overallRating ?? null },
    { label: 'Technical', get: (r) => r.report?.technicalScore ?? null },
    { label: 'Communication', get: (r) => r.report?.communicationScore ?? null },
    { label: 'Behavioral', get: (r) => r.report?.behavioralScore ?? null },
    { label: 'Coding', get: (r) => r.report?.codingScore ?? null },
  ];

  // Sub-score dimensions that at least one candidate has data for.
  const detailCategories = ['Communication', 'Technical', 'Behavioral'].filter((cat) =>
    rows.some((r) => (r.scoresByCategory[cat]?.length ?? 0) > 0),
  );

  return (
    <>
      <PageHeader
        title="Compare candidates"
        description={`${rows.length} candidates side by side. The strongest value in each row is highlighted.`}
        breadcrumbs={[{ label: 'Sessions', href: '/sessions' }, { label: 'Compare' }]}
        actions={
          <Link href={`/sessions/${id}`}>
            <Button variant="outline" size="sm">
              Back to session
            </Button>
          </Link>
        }
      />

      <Card className="mb-4">
        <div className="overflow-guard">
          <table className="w-full text-sm" style={{ minWidth: `${14 + rows.length * 12}rem` }}>
            <thead>
              <tr className="border-b border-border">
                <th className="w-44 py-3 pl-5 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  Metric
                </th>
                {rows.map((r) => (
                  <th key={r.sessionCandidateId} className="px-4 py-3 text-left">
                    <div className="flex items-center gap-2.5">
                      <div
                        className={cn(
                          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                          avatarColor(r.name),
                        )}
                      >
                        {initials(r.name)}
                      </div>
                      <div className="min-w-0">
                        {r.report ? (
                          <Link href={`/reports/${r.report.id}`} className="font-medium text-foreground hover:text-primary">
                            {r.name}
                          </Link>
                        ) : (
                          <span className="font-medium text-foreground">{r.name}</span>
                        )}
                        <p className="truncate text-xs font-normal text-muted-foreground">{r.email}</p>
                      </div>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>

            <tbody className="divide-y divide-border">
              <tr>
                <td className="py-3 pl-5 font-medium text-muted-foreground">Recommendation</td>
                {rows.map((r) => (
                  <td key={r.sessionCandidateId} className="px-4 py-3">
                    {r.report ? <StatusBadge value={r.report.hiringRecommendation} /> : <StatusBadge value={r.status} />}
                  </td>
                ))}
              </tr>

              {metrics.map((metric) => {
                const values = rows.map(metric.get);
                const best = bestIndex(values);

                return (
                  <tr key={metric.label}>
                    <td className="py-3 pl-5 font-medium text-muted-foreground">{metric.label}</td>
                    {values.map((value, i) => (
                      <td
                        key={rows[i]!.sessionCandidateId}
                        className={cn('px-4 py-3', i === best && value != null && 'bg-success-soft')}
                      >
                        {value == null ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          <div className="flex items-center gap-2">
                            <Badge tone={scoreTone(value)}>{value.toFixed(1)}</Badge>
                          </div>
                        )}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Sub-score detail */}
      {detailCategories.map((category) => {
        const labels = Array.from(
          new Set(rows.flatMap((r) => (r.scoresByCategory[category] ?? []).map((s) => s.label))),
        );

        return (
          <Card key={category} className="mb-4">
            <CardBody>
              <h3 className="mb-4 text-sm font-semibold">{category} breakdown</h3>

              <div className="overflow-guard">
                <table className="w-full text-sm" style={{ minWidth: `${14 + rows.length * 12}rem` }}>
                  <tbody className="divide-y divide-border">
                    {labels.map((label) => {
                      const values = rows.map(
                        (r) => (r.scoresByCategory[category] ?? []).find((s) => s.label === label)?.value ?? null,
                      );
                      const best = bestIndex(values);

                      return (
                        <tr key={label}>
                          <td className="w-44 py-2.5 pr-4 text-muted-foreground">{label}</td>
                          {values.map((value, i) => (
                            <td
                              key={rows[i]!.sessionCandidateId}
                              className={cn('px-4 py-2.5', i === best && value != null && 'bg-success-soft')}
                            >
                              {value == null ? (
                                <span className="text-xs text-muted-foreground">—</span>
                              ) : (
                                <ScoreBar value={value} className="min-w-[6rem]" />
                              )}
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardBody>
          </Card>
        );
      })}

      {/* Narrative */}
      <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(18rem, 1fr))` }}>
        {rows.map((r) => (
          <Card key={r.sessionCandidateId}>
            <CardBody>
              <h3 className="text-sm font-semibold">{r.name}</h3>

              {r.report?.recommendationReason && (
                <p className="mt-1.5 text-sm text-muted-foreground">{r.report.recommendationReason}</p>
              )}

              {r.report?.details.strengths?.length ? (
                <>
                  <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-success">Strengths</p>
                  <ul className="mt-1.5 space-y-1 text-sm text-foreground">
                    {r.report.details.strengths.slice(0, 3).map((s, i) => (
                      <li key={i}>· {s.point}</li>
                    ))}
                  </ul>
                </>
              ) : null}

              {r.report?.details.weaknesses?.length ? (
                <>
                  <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-warning">Weaknesses</p>
                  <ul className="mt-1.5 space-y-1 text-sm text-foreground">
                    {r.report.details.weaknesses.slice(0, 3).map((w, i) => (
                      <li key={i}>· {w.point}</li>
                    ))}
                  </ul>
                </>
              ) : null}

              {r.report && (
                <Link href={`/reports/${r.report.id}`} className="mt-4 block">
                  <Button variant="outline" size="sm" className="w-full">
                    Full report
                  </Button>
                </Link>
              )}
            </CardBody>
          </Card>
        ))}
      </div>
    </>
  );
}
