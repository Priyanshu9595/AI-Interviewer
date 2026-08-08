'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Bot, Calendar, FileText, MessageSquare, Plus, Radio, Search, Video } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { useToast } from '@/components/Toast';
import { Badge, Button, Card, EmptyState, Input, Select, Skeleton } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { statusMeta, type MeetInterview } from '@/lib/meetInterview';
import { cn, formatDate, formatDuration, formatTime, initials, avatarColor } from '@/lib/utils';

/**
 * Every interview the AI runs inside a Google Meet call.
 *
 * Refreshes on a timer while anything is live, so a recruiter who leaves this
 * page open sees interviews move through their stages without reloading. When
 * nothing is running the polling stops rather than hitting the API forever.
 */
const LIVE_POLL_MS = 5_000;

export default function MeetInterviewsPage() {
  const toast = useToast();

  const [interviews, setInterviews] = useState<MeetInterview[] | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'ALL' | 'LIVE' | 'SCHEDULED' | 'COMPLETED' | 'FAILED'>('ALL');

  const load = useCallback(
    async (quiet = false) => {
      try {
        const { data } = await api.get<{ interviews: MeetInterview[] }>('/interviews');
        setInterviews(data.interviews);
      } catch (err) {
        if (!quiet) toast.error('Could not load interviews', errorMessage(err));
        setInterviews((current) => current ?? []);
      }
    },
    [toast],
  );

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const anyLive = useMemo(() => (interviews ?? []).some((i) => statusMeta(i.status).live), [interviews]);

  useEffect(() => {
    if (!anyLive) return;
    const timer = setInterval(() => void load(true), LIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [anyLive, load]);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();

    return (interviews ?? []).filter((interview) => {
      if (term) {
        const haystack = `${interview.candidateName} ${interview.candidateEmail} ${interview.jobTitle}`.toLowerCase();
        if (!haystack.includes(term)) return false;
      }

      switch (filter) {
        case 'LIVE':
          return statusMeta(interview.status).live;
        case 'SCHEDULED':
          return interview.status === 'SCHEDULED';
        case 'COMPLETED':
          return interview.status === 'COMPLETED';
        case 'FAILED':
          return interview.status === 'FAILED' || interview.status === 'CANCELLED';
        default:
          return true;
      }
    });
  }, [interviews, search, filter]);

  return (
    <div>
      <PageHeader
        title="AI interviews"
        description="The AI interviewer joins a Google Meet, Zoom or Teams link you already created, runs the interview, and files a report."
        actions={
          <Link href="/ai-interviews/new">
            <Button>
              <Plus className="h-4 w-4" />
              Create AI interview
            </Button>
          </Link>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search candidate or role"
            className="pl-9"
          />
        </div>
        <Select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} className="w-auto min-w-[150px]">
          <option value="ALL">All interviews</option>
          <option value="LIVE">Live now</option>
          <option value="SCHEDULED">Scheduled</option>
          <option value="COMPLETED">Completed</option>
          <option value="FAILED">Failed or cancelled</option>
        </Select>
      </div>

      {interviews === null ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[86px] w-full" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <Card>
          <EmptyState
            icon={Bot}
            title={interviews.length === 0 ? 'No AI interviews yet' : 'Nothing matches that filter'}
            description={
              interviews.length === 0
                ? 'Create a meeting in your own calendar — Google Meet, Zoom or Teams — then paste the link here and the AI will join it at the scheduled time.'
                : undefined
            }
            action={
              interviews.length === 0 ? (
                <Link href="/ai-interviews/new">
                  <Button>
                    <Plus className="h-4 w-4" />
                    Create AI interview
                  </Button>
                </Link>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <div className="space-y-2">
          {visible.map((interview) => (
            <InterviewRow key={interview.id} interview={interview} />
          ))}
        </div>
      )}
    </div>
  );
}

function InterviewRow({ interview }: { interview: MeetInterview }) {
  const meta = statusMeta(interview.status);
  const scheduled = new Date(interview.scheduledAt);

  return (
    <Card className="px-4 py-3 transition-colors hover:border-primary/40">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
            avatarColor(interview.candidateName),
          )}
        >
          {initials(interview.candidateName)}
        </div>

        <div className="min-w-[180px] flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`/ai-interviews/${interview.id}`}
              className="truncate text-sm font-semibold text-foreground hover:text-primary"
            >
              {interview.candidateName}
            </Link>
            {meta.live && (
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600">
                <Radio className="h-3 w-3 animate-pulse" />
                LIVE
              </span>
            )}
          </div>
          <p className="truncate text-xs text-muted-foreground">{interview.jobTitle}</p>
        </div>

        <div className="hidden min-w-[150px] text-xs text-muted-foreground sm:block">
          <p className="flex items-center gap-1.5">
            <Calendar className="h-3.5 w-3.5 shrink-0" />
            {formatDate(scheduled)} at {formatTime(scheduled)}
          </p>
          <p className="mt-0.5 flex items-center gap-1.5">
            <Video className="h-3.5 w-3.5 shrink-0" />
            {interview.platformLabel} · {formatDuration(interview.durationMinutes)}
          </p>
        </div>

        <div className="min-w-[150px]">
          <Badge tone={meta.tone}>
            <span className={cn('h-1.5 w-1.5 rounded-full bg-current', meta.live && 'animate-pulse')} />
            {meta.label}
          </Badge>
          {/* Why, not just what. A cancelled row that does not say "the
              candidate did not join" sends the recruiter looking for a bug. */}
          {interview.statusDetail && interview.status !== 'FAILED' && (
            <p className="mt-1 line-clamp-2 max-w-[240px] text-[11px] text-muted-foreground">
              {interview.statusDetail}
            </p>
          )}
          {interview.status === 'FAILED' && interview.errorMessage && (
            <p className="mt-1 line-clamp-2 max-w-[240px] text-[11px] text-danger">{interview.errorMessage}</p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Link href={`/ai-interviews/${interview.id}`}>
            <Button size="sm" variant={meta.live ? 'primary' : 'outline'}>
              {meta.live ? 'View live' : 'Open'}
            </Button>
          </Link>
          <Link href={`/ai-interviews/${interview.id}?tab=transcript`} title="Transcript">
            <Button size="sm" variant="ghost">
              <MessageSquare className="h-4 w-4" />
            </Button>
          </Link>
          {interview.hasReport && (
            <Link href={`/ai-interviews/${interview.id}?tab=report`} title="Report">
              <Button size="sm" variant="ghost">
                <FileText className="h-4 w-4" />
              </Button>
            </Link>
          )}
        </div>
      </div>
    </Card>
  );
}
