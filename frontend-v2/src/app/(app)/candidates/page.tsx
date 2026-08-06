'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, Search, Users } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { useToast } from '@/components/Toast';
import { Badge, Button, Card, CardBody, EmptyState, Input, Skeleton, StatusBadge, scoreTone } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { avatarColor, cn, formatDate, initials } from '@/lib/utils';

interface CandidateRow {
  id: string;
  name: string;
  email: string;
  mobile: string | null;
  createdAt: string;
  sessions: Array<{
    id: string;
    status: string;
    interviewSession: { id: string; title: string; scheduledAt: string };
    report: { id: string; overallRating: number; hiringRecommendation: string } | null;
  }>;
}

export default function CandidatesPage() {
  const toast = useToast();
  const [rows, setRows] = useState<CandidateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: CandidateRow[]; totalPages: number; total: number }>('/candidates', {
        params: { search: search || undefined, page, limit: 20 },
      });
      setRows(res.data.data);
      setTotalPages(res.data.totalPages);
      setTotal(res.data.total);
    } catch (err) {
      toast.error('Could not load candidates', errorMessage(err));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, page]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), search ? 350 : 0);
    return () => clearTimeout(timer);
  }, [load, search]);

  useEffect(() => {
    setPage(1);
  }, [search]);

  return (
    <>
      <PageHeader
        title="Candidates"
        description={total > 0 ? `${total} candidate${total === 1 ? '' : 's'} across your sessions` : undefined}
      />

      <Card className="mb-4">
        <CardBody>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name or email"
              className="pl-9"
            />
          </div>
        </CardBody>
      </Card>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={Users}
            title={search ? 'No candidates match that search' : 'No candidates yet'}
            description={
              search
                ? 'Try a different name or email.'
                : 'Candidates appear here once you add them to an interview session.'
            }
            action={
              search ? (
                <Button variant="outline" size="sm" onClick={() => setSearch('')}>
                  Clear search
                </Button>
              ) : (
                <Link href="/sessions/new">
                  <Button size="sm">Create a session</Button>
                </Link>
              )
            }
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map((c) => (
            <Card key={c.id}>
              <CardBody>
                <div className="flex flex-wrap items-start gap-3">
                  <div
                    className={cn(
                      'flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold',
                      avatarColor(c.name),
                    )}
                  >
                    {initials(c.name)}
                  </div>

                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground">{c.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {c.email}
                      {c.mobile ? ` · ${c.mobile}` : ''}
                    </p>
                  </div>

                  <Badge>
                    {c.sessions.length} interview{c.sessions.length === 1 ? '' : 's'}
                  </Badge>
                </div>

                {c.sessions.length > 0 && (
                  <ul className="mt-3.5 space-y-2 border-t border-border pt-3">
                    {c.sessions.map((s) => (
                      <li key={s.id} className="flex flex-wrap items-center gap-2 text-sm">
                        <Link
                          href={`/sessions/${s.interviewSession.id}`}
                          className="font-medium text-foreground hover:text-primary"
                        >
                          {s.interviewSession.title}
                        </Link>
                        <span className="text-xs text-muted-foreground">
                          {formatDate(s.interviewSession.scheduledAt)}
                        </span>
                        <StatusBadge value={s.status} />

                        {s.report && (
                          <>
                            <Badge tone={scoreTone(s.report.overallRating)}>{s.report.overallRating.toFixed(1)}</Badge>
                            <StatusBadge value={s.report.hiringRecommendation} />
                            <Link
                              href={`/reports/${s.report.id}`}
                              className="text-xs font-medium text-primary hover:underline"
                            >
                              View report
                            </Link>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="mt-5 flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              <ChevronLeft className="h-4 w-4" />
              Previous
            </Button>
            <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
