'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { FileText, Play, Video } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { useToast } from '@/components/Toast';
import { RecordingPlayer } from '@/components/interview/RecordingPlayer';
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  Modal,
  Skeleton,
  StatusBadge,
  scoreTone,
} from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { avatarColor, cn, formatClock, formatDateTime, initials } from '@/lib/utils';

interface RecordingRow {
  id: string;
  sessionCandidateId: string;
  storage: string;
  sizeBytes: number;
  durationSeconds: number;
  recordedAt: string;
  candidate: { name: string; email: string };
  session: { id: string; title: string };
  report: { id: string; overallRating: number; hiringRecommendation: string } | null;
}

export default function RecordingsPage() {
  const toast = useToast();
  const [rows, setRows] = useState<RecordingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState<RecordingRow | null>(null);

  useEffect(() => {
    api
      .get<RecordingRow[]>('/recordings')
      .then((res) => setRows(res.data))
      .catch((err) => toast.error('Could not load recordings', errorMessage(err)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return (
      <>
        <PageHeader title="Recordings" />
        <Skeleton className="h-96" />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Recordings"
        description={
          rows.length
            ? `${rows.length} recorded interview${rows.length === 1 ? '' : 's'}`
            : 'Interview recordings appear here once candidates complete their sessions.'
        }
      />

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={Video}
            title="No recordings yet"
            description="A recording is saved automatically when a candidate finishes an interview, as long as recording is enabled in the session settings."
          />
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((r) => (
            <Card key={r.id} className="flex flex-col">
              <button
                onClick={() => setPlaying(r)}
                className="group relative flex aspect-video items-center justify-center rounded-t-lg bg-slate-900 overflow-hidden transition-transform hover:opacity-95"
                aria-label={`Play ${r.candidate.name}'s interview`}
              >
                {/* Beautiful placeholder background */}
                <div className="absolute inset-0 bg-gradient-to-br from-indigo-600/20 via-purple-600/20 to-slate-900/80" />
                <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-20 mix-blend-overlay" />
                <Video className="absolute h-24 w-24 text-white/5 -rotate-12 scale-150" />
                
                <span className="relative flex h-14 w-14 items-center justify-center rounded-full bg-white/20 shadow-lg shadow-black/20 backdrop-blur-md transition-transform group-hover:scale-110 group-hover:bg-white/30">
                  <Play className="ml-1 h-6 w-6 fill-white text-white" />
                </span>
                {r.durationSeconds > 0 && (
                  <span className="absolute bottom-2 right-2 rounded bg-black/60 px-1.5 py-0.5 font-mono text-xs text-white">
                    {formatClock(r.durationSeconds)}
                  </span>
                )}
              </button>

              <CardBody className="flex flex-1 flex-col gap-2">
                <div className="flex items-start gap-2.5">
                  <div
                    className={cn(
                      'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                      avatarColor(r.candidate.name),
                    )}
                  >
                    {initials(r.candidate.name)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{r.candidate.name}</p>
                    <Link
                      href={`/sessions/${r.session.id}`}
                      className="truncate text-xs text-muted-foreground hover:text-primary"
                    >
                      {r.session.title}
                    </Link>
                  </div>
                </div>

                <p className="text-xs text-muted-foreground">{formatDateTime(r.recordedAt)}</p>

                <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
                  {r.report ? (
                    <>
                      <Badge tone={scoreTone(r.report.overallRating)}>{r.report.overallRating.toFixed(1)}</Badge>
                      <StatusBadge value={r.report.hiringRecommendation} />
                      <Link href={`/reports/${r.report.id}`} className="ml-auto">
                        <Button variant="ghost" size="sm">
                          <FileText className="h-3.5 w-3.5" />
                          Report
                        </Button>
                      </Link>
                    </>
                  ) : (
                    <Badge>Not evaluated</Badge>
                  )}
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={Boolean(playing)}
        onClose={() => setPlaying(null)}
        title={playing ? `${playing.candidate.name} — ${playing.session.title}` : ''}
        size="lg"
      >
        {playing && <RecordingPlayer sessionCandidateId={playing.sessionCandidateId} />}
      </Modal>
    </>
  );
}
