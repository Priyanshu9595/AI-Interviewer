'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Clock, Copy, Download, Globe, Users } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { useToast } from '@/components/Toast';
import { CandidatesTab, SessionCandidate } from '@/components/sessions/CandidatesTab';
import { QuestionsTab, Question } from '@/components/sessions/QuestionsTab';
import { ResultsTab } from '@/components/sessions/ResultsTab';
import { SettingsTab, SessionDetail } from '@/components/sessions/SettingsTab';
import { Alert, Badge, Button, Card, CardBody, Skeleton, StatusBadge, Tabs } from '@/components/ui';
import { api, downloadFile, errorMessage } from '@/lib/api';
import { formatDateTime, formatDuration } from '@/lib/utils';

type TabId = 'candidates' | 'questions' | 'results' | 'settings';

interface FullSession extends SessionDetail {
  candidates: SessionCandidate[];
  questionSet: { questions: Question[] } | null;
}

export default function SessionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();

  const [session, setSession] = useState<FullSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [tab, setTab] = useState<TabId>('candidates');

  const load = useCallback(async () => {
    try {
      const res = await api.get<FullSession>(`/sessions/${id}`);
      setSession(res.data);
    } catch (err) {
      setNotFound(true);
      toast.error('Could not load the session', errorMessage(err));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Questions generate in the background; poll briefly until they land.
  useEffect(() => {
    if (!session || (session.questionSet?.questions.length ?? 0) > 0) return;

    let attempts = 0;
    const timer = setInterval(() => {
      attempts++;
      if (attempts > 10) return clearInterval(timer);
      void load();
    }, 4000);

    return () => clearInterval(timer);
  }, [session, load]);

  if (loading) {
    return (
      <>
        <Skeleton className="mb-6 h-16" />
        <Skeleton className="h-96" />
      </>
    );
  }

  if (notFound || !session) {
    return (
      <Card>
        <CardBody>
          <Alert tone="danger" title="Session not found">
            It may have been deleted, or it belongs to another account.
          </Alert>
        </CardBody>
      </Card>
    );
  }

  const questions = session.questionSet?.questions ?? [];
  const completed = session.candidates.filter((c) => c.status === 'COMPLETED').length;
  const evaluated = session.candidates.filter((c) => c.report).length;

  const exportExcel = async () => {
    try {
      await downloadFile(`/sessions/${session.id}/export.xlsx`, `${session.title.replace(/[^a-z0-9]/gi, '_')}.xlsx`);
    } catch (err) {
      toast.error('Export failed', errorMessage(err));
    }
  };

  const copyMeetingLink = async () => {
    if (!session.meetingLink) return;
    try {
      await navigator.clipboard.writeText(session.meetingLink);
      toast.success('Meeting link copied');
    } catch {
      prompt('Meeting link:', session.meetingLink);
    }
  };

  return (
    <>
      <PageHeader
        title={session.title}
        breadcrumbs={[{ label: 'Sessions', href: '/sessions' }, { label: session.title }]}
        actions={
          <>
            {session.meetingLink && (
              <Button variant="outline" size="sm" onClick={copyMeetingLink}>
                <Copy className="h-4 w-4" />
                Meeting link
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={exportExcel}>
              <Download className="h-4 w-4" />
              Export
            </Button>
          </>
        }
      />

      <Card className="mb-5">
        <CardBody className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge value={session.status} />
            <StatusBadge value={session.type} />
            <Badge>{session.experienceLevel}</Badge>
          </div>

          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Clock className="h-4 w-4" />
            {formatDateTime(session.scheduledAt)} · {formatDuration(session.durationMinutes)}
          </span>

          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Users className="h-4 w-4" />
            {session.candidates.length} invited · {completed} completed
          </span>

          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Globe className="h-4 w-4" />
            {session.language}
          </span>
        </CardBody>
      </Card>

      {questions.length === 0 && (
        <Alert tone="info" title="Generating interview questions" className="mb-5">
          The AI is reading the job description and writing the question set. This usually takes under a minute — the
          page refreshes on its own.
        </Alert>
      )}

      <Tabs<TabId>
        active={tab}
        onChange={setTab}
        className="mb-5"
        tabs={[
          { id: 'candidates', label: 'Candidates', count: session.candidates.length },
          { id: 'questions', label: 'Questions', count: questions.length },
          { id: 'results', label: 'Results', count: evaluated },
          { id: 'settings', label: 'Settings' },
        ]}
      />

      {tab === 'candidates' && (
        <CandidatesTab sessionId={session.id} candidates={session.candidates} onChanged={load} />
      )}

      {tab === 'questions' && <QuestionsTab sessionId={session.id} questions={questions} onChanged={load} />}
      {tab === 'results' && <ResultsTab sessionId={session.id} sessionTitle={session.title} />}
      {tab === 'settings' && <SettingsTab session={session} onChanged={load} />}
    </>
  );
}
