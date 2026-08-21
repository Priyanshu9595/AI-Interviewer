'use client';

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { FileText, Search } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { useToast } from '@/components/Toast';
import { Badge, Card, CardBody, EmptyState, Input, Skeleton, StatusBadge, scoreTone } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { avatarColor, cn, formatDateTime, initials } from '@/lib/utils';

interface ReportRow {
  id: string;
  overallRating: number;
  /** The two halves the overall is the mean of, resolved by the API. */
  halves: { soft: number; hard: number };
  hiringRecommendation: string;
  createdAt: string;
  sessionCandidate: {
    candidate: { name: string; email: string };
    interviewSession: { id: string; title: string; type: string };
  };
}

export default function ReportsPage() {
  const toast = useToast();
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    api
      .get<ReportRow[]>('/reports/recent', { params: { limit: 50 } })
      .then((res) => setRows(res.data))
      .catch((err) => toast.error('Could not load reports', errorMessage(err)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const groupedRows = useMemo(() => {
    const groups: Record<string, ReportRow[]> = {};
    const query = searchQuery.toLowerCase().trim();
    for (const r of rows) {
      const role = r.sessionCandidate.interviewSession.title;
      if (query && !role.toLowerCase().includes(query)) continue;
      if (!groups[role]) groups[role] = [];
      groups[role].push(r);
    }
    return groups;
  }, [rows, searchQuery]);

  if (loading) {
    return (
      <>
        <PageHeader title="Reports" />
        <Skeleton className="h-96" />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Reports"
        description={
          rows.length ? `${rows.length} evaluated interview${rows.length === 1 ? '' : 's'}` : undefined
        }
      />

      {rows.length > 0 && (
        <Card className="mb-6">
          <CardBody className="py-3">
            <div className="relative max-w-sm">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by job title"
                className="pl-9"
              />
            </div>
          </CardBody>
        </Card>
      )}

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={FileText}
            title={searchQuery ? 'No roles found matching your search' : 'No reports yet'}
            description={searchQuery ? 'Try a different search term.' : 'A report is generated automatically as soon as a candidate finishes their interview.'}
          />
        </Card>
      ) : (
        <div className="space-y-8">
          {Object.entries(groupedRows).map(([role, roleRows]) => (
            <div key={role} className="space-y-4">
              <h2 className="text-xl font-semibold tracking-tight text-foreground">{role}</h2>
              <Card>
                <div className="overflow-guard">
                  <table className="w-full min-w-[48rem] text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="py-2.5 pl-5 font-medium">Candidate</th>
                        {/* The two halves rather than the four dimensions. The overall is
                            their mean, so a row can be checked at a glance — where a
                            column of Tech, Comm and Behav left out coding entirely and
                            made every overall look wrong. The scale sits in the header
                            because repeating "/ 10" in every cell is noise. */}
                        <th className="py-2.5 text-center font-medium">Overall / 10</th>
                        <th className="py-2.5 text-center font-medium">Comm &amp; behav / 10</th>
                        <th className="py-2.5 text-center font-medium">Tech &amp; coding / 10</th>
                        <th className="py-2.5 font-medium">Recommendation</th>
                        <th className="py-2.5 pr-5 font-medium">Date</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {roleRows.map((r) => (
                        <tr key={r.id} className="transition-colors hover:bg-muted/50">
                          <td className="py-3 pl-5">
                            <Link href={`/reports/${r.id}`} className="flex items-center gap-2.5">
                              <div
                                className={cn(
                                  'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                                  avatarColor(r.sessionCandidate.candidate.name),
                                )}
                              >
                                {initials(r.sessionCandidate.candidate.name)}
                              </div>
                              <div className="min-w-0">
                                <p className="truncate font-medium text-foreground">
                                  {r.sessionCandidate.candidate.name}
                                </p>
                                <p className="truncate text-xs text-muted-foreground">
                                  {r.sessionCandidate.candidate.email}
                                </p>
                              </div>
                            </Link>
                          </td>

                          <td className="py-3 text-center">
                            <Badge tone={scoreTone(r.overallRating)}>{r.overallRating.toFixed(1)}</Badge>
                          </td>
                          <td className="py-3 text-center tabular-nums text-muted-foreground">
                            {r.halves.soft.toFixed(1)}
                          </td>
                          <td className="py-3 text-center tabular-nums text-muted-foreground">
                            {r.halves.hard.toFixed(1)}
                          </td>

                          <td className="py-3">
                            <StatusBadge value={r.hiringRecommendation} />
                          </td>
                          <td className="py-3 pr-5 text-xs text-muted-foreground">
                            {formatDateTime(r.createdAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
