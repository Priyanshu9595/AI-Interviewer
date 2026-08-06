'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { CalendarClock, ChevronLeft, ChevronRight, Plus, Search, Users } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  Input,
  Select,
  Skeleton,
  StatusBadge,
} from '@/components/ui';
import { useToast } from '@/components/Toast';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, formatDuration, relativeTime, truncate } from '@/lib/utils';

interface SessionRow {
  id: string;
  title: string;
  type: string;
  status: string;
  scheduledAt: string;
  durationMinutes: number;
  experienceLevel: string;
  skills: string[];
  candidateCount: number;
  completedCount: number;
  questionCount: number;
}

export default function SessionsPage() {
  const toast = useToast();

  const [rows, setRows] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: SessionRow[]; totalPages: number; total: number }>('/sessions', {
        params: { search: search || undefined, status: status || undefined, type: type || undefined, page, limit: 10 },
      });
      setRows(res.data.data);
      setTotalPages(res.data.totalPages);
      setTotal(res.data.total);
    } catch (err) {
      toast.error('Could not load sessions', errorMessage(err));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, status, type, page]);

  // Debounce so typing in the search box does not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => void load(), search ? 350 : 0);
    return () => clearTimeout(timer);
  }, [load, search]);

  // Any filter change resets to the first page.
  useEffect(() => {
    setPage(1);
  }, [search, status, type]);

  return (
    <>
      <PageHeader
        title="Interview sessions"
        description={total > 0 ? `${total} session${total === 1 ? '' : 's'}` : 'Create a session to start interviewing.'}
        actions={
          <Link href="/sessions/new">
            <Button>
              <Plus className="h-4 w-4" />
              New session
            </Button>
          </Link>
        }
      />

      <Card className="mb-4">
        <CardBody className="flex flex-col gap-3 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by title or job description"
              className="pl-9"
            />
          </div>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="sm:w-44">
            <option value="">All statuses</option>
            <option value="DRAFT">Draft</option>
            <option value="SCHEDULED">Scheduled</option>
            <option value="ACTIVE">Active</option>
            <option value="COMPLETED">Completed</option>
            <option value="CANCELLED">Cancelled</option>
          </Select>
          <Select value={type} onChange={(e) => setType(e.target.value)} className="sm:w-40">
            <option value="">All types</option>
            <option value="TECHNICAL">Technical</option>
            <option value="HR">HR</option>
            <option value="MIXED">Mixed</option>
          </Select>
        </CardBody>
      </Card>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={CalendarClock}
            title={search || status || type ? 'No sessions match those filters' : 'No sessions yet'}
            description={
              search || status || type
                ? 'Try clearing the filters.'
                : 'Create your first session, add candidates, and the AI will handle the rest.'
            }
            action={
              search || status || type ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setSearch('');
                    setStatus('');
                    setType('');
                  }}
                >
                  Clear filters
                </Button>
              ) : (
                <Link href="/sessions/new">
                  <Button size="sm">
                    <Plus className="h-4 w-4" />
                    New session
                  </Button>
                </Link>
              )
            }
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map((s) => (
            <Link key={s.id} href={`/sessions/${s.id}`} className="block">
              <Card className="transition-colors hover:border-primary/40">
                <CardBody>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-semibold text-foreground">{s.title}</h3>
                        <StatusBadge value={s.status} />
                        <StatusBadge value={s.type} />
                      </div>

                      <p className="mt-1 text-sm text-muted-foreground">
                        {s.experienceLevel} · {formatDuration(s.durationMinutes)}
                      </p>

                      {s.skills.length > 0 && (
                        <div className="mt-2.5 flex flex-wrap gap-1.5">
                          {s.skills.slice(0, 5).map((skill) => (
                            <Badge key={skill}>{truncate(skill, 22)}</Badge>
                          ))}
                          {s.skills.length > 5 && <Badge>+{s.skills.length - 5}</Badge>}
                        </div>
                      )}
                    </div>

                    <div className="shrink-0 text-right">
                      <p className="text-sm font-medium text-foreground">{relativeTime(s.scheduledAt)}</p>
                      <p className="text-xs text-muted-foreground">{formatDateTime(s.scheduledAt)}</p>
                    </div>
                  </div>

                  <div className="mt-3.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-border pt-3 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      <Users className="h-3.5 w-3.5" />
                      {s.candidateCount} candidate{s.candidateCount === 1 ? '' : 's'}
                    </span>
                    <span>{s.completedCount} completed</span>
                    <span>{s.questionCount} questions ready</span>
                  </div>
                </CardBody>
              </Card>
            </Link>
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
