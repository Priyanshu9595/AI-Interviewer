'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { BarChart3, Crown, Download, Sparkles, Trophy } from 'lucide-react';
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
  ScoreBar,
  Skeleton,
  StatusBadge,
  scoreTone,
} from '@/components/ui';
import { api, downloadFile, errorMessage } from '@/lib/api';
import { avatarColor, cn, initials } from '@/lib/utils';

interface Ranked {
  rank: number;
  sessionCandidateId: string;
  name: string;
  email: string;
  status: string;
  reportId: string | null;
  overall: number;
  technical: number;
  communication: number;
  behavioral: number;
  coding: number | null;
  recommendation: string | null;
  recommendationReason: string | null;
  summary: string | null;
  strengths: string[];
  weaknesses: string[];
}

interface Shortlist {
  shortlisted: Ranked[];
  totalEvaluated: number;
  totalCandidates: number;
  note: string;
}

const MEDALS = ['text-amber-500', 'text-slate-400', 'text-amber-700'];

export function ResultsTab({ sessionId, sessionTitle }: { sessionId: string; sessionTitle: string }) {
  const toast = useToast();
  const [ranked, setRanked] = useState<Ranked[]>([]);
  const [shortlist, setShortlist] = useState<Shortlist | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, s] = await Promise.all([
        api.get<Ranked[]>(`/sessions/${sessionId}/leaderboard`),
        api.get<Shortlist>(`/sessions/${sessionId}/shortlist`),
      ]);
      setRanked(r.data);
      setShortlist(s.data);
    } catch (err) {
      toast.error('Could not load results', errorMessage(err));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const exportExcel = async () => {
    try {
      await downloadFile(`/sessions/${sessionId}/export.xlsx`, `${sessionTitle.replace(/[^a-z0-9]/gi, '_')}.xlsx`);
    } catch (err) {
      toast.error('Export failed', errorMessage(err));
    }
  };

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-40" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  const evaluated = ranked.filter((r) => r.reportId);

  if (evaluated.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={BarChart3}
          title="No results yet"
          description="Rankings and the shortlist appear here once candidates finish their interviews and reports are generated."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Shortlist */}
      {shortlist && (
        <Card>
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-1.5">
                <Sparkles className="h-4 w-4 text-primary" />
                AI shortlist
              </CardTitle>
              <p className="mt-0.5 text-sm text-muted-foreground">{shortlist.note}</p>
            </div>
            <Button variant="outline" size="sm" onClick={exportExcel}>
              <Download className="h-4 w-4" />
              Export session
            </Button>
          </CardHeader>

          <CardBody>
            {shortlist.shortlisted.length === 0 ? (
              <Alert tone="warning">
                No candidate reached the hiring bar for this role. Consider widening the pool or revisiting the bar in
                session settings.
              </Alert>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {shortlist.shortlisted.map((c, i) => (
                  <div key={c.sessionCandidateId} className="rounded-md border border-border p-3.5">
                    <div className="flex items-start gap-2.5">
                      <div
                        className={cn(
                          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                          avatarColor(c.name),
                        )}
                      >
                        {initials(c.name)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-1.5 truncate text-sm font-medium text-foreground">
                          {i < 3 && <Crown className={cn('h-3.5 w-3.5 shrink-0', MEDALS[i])} />}
                          {c.name}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">{c.email}</p>
                      </div>
                    </div>

                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                      <Badge tone={scoreTone(c.overall)}>{c.overall.toFixed(1)} / 10</Badge>
                      {c.recommendation && <StatusBadge value={c.recommendation} />}
                    </div>

                    {c.strengths[0] && (
                      <p className="mt-2.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                        {c.strengths[0]}
                      </p>
                    )}

                    {c.reportId && (
                      <Link href={`/reports/${c.reportId}`} className="mt-3 block">
                        <Button variant="outline" size="sm" className="w-full">
                          View full report
                        </Button>
                      </Link>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {/* Leaderboard */}
      <Card>
        <CardHeader>
          <div>
            <CardTitle className="flex items-center gap-1.5">
              <Trophy className="h-4 w-4 text-muted-foreground" />
              Candidate ranking
            </CardTitle>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Ordered by hiring recommendation, then overall score. Select two or more to compare.
            </p>
          </div>
          {selected.length >= 2 && (
            <Link href={`/sessions/${sessionId}/compare?ids=${selected.join(',')}`}>
              <Button size="sm">Compare {selected.length}</Button>
            </Link>
          )}
        </CardHeader>

        <div className="overflow-guard">
          <table className="w-full min-w-[52rem] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="w-10 py-2.5 pl-5" />
                <th className="w-12 py-2.5 font-medium">#</th>
                <th className="py-2.5 font-medium">Candidate</th>
                <th className="py-2.5 text-center font-medium">Overall</th>
                <th className="py-2.5 font-medium">Technical</th>
                <th className="py-2.5 font-medium">Communication</th>
                <th className="py-2.5 font-medium">Behavioral</th>
                <th className="py-2.5 pr-5 font-medium">Recommendation</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {ranked.map((c) => (
                <tr key={c.sessionCandidateId} className={cn('transition-colors', c.reportId && 'hover:bg-muted/50')}>
                  <td className="py-3 pl-5">
                    {c.reportId && (
                      <input
                        type="checkbox"
                        checked={selected.includes(c.sessionCandidateId)}
                        onChange={() => toggle(c.sessionCandidateId)}
                        className="h-4 w-4 cursor-pointer rounded border-input accent-[hsl(var(--primary))]"
                        aria-label={`Select ${c.name}`}
                      />
                    )}
                  </td>

                  <td className="py-3 font-mono text-xs text-muted-foreground">{c.rank || '—'}</td>

                  <td className="py-3">
                    <div className="flex items-center gap-2.5">
                      <div
                        className={cn(
                          'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                          avatarColor(c.name),
                        )}
                      >
                        {initials(c.name)}
                      </div>
                      <div className="min-w-0">
                        {c.reportId ? (
                          <Link href={`/reports/${c.reportId}`} className="font-medium text-foreground hover:text-primary">
                            {c.name}
                          </Link>
                        ) : (
                          <span className="font-medium text-foreground">{c.name}</span>
                        )}
                        <p className="truncate text-xs text-muted-foreground">{c.email}</p>
                      </div>
                    </div>
                  </td>

                  <td className="py-3 text-center">
                    {c.reportId ? (
                      <Badge tone={scoreTone(c.overall)}>{c.overall.toFixed(1)}</Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>

                  {(['technical', 'communication', 'behavioral'] as const).map((key) => (
                    <td key={key} className="py-3 pr-4">
                      {c.reportId ? (
                        <ScoreBar value={c[key]} className="min-w-[5rem]" />
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                  ))}

                  <td className="py-3 pr-5">
                    {c.recommendation ? <StatusBadge value={c.recommendation} /> : <StatusBadge value={c.status} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
