'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useToast } from '@/components/Toast';
import { Badge, Button } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { relativeTime } from '@/lib/utils';

type State = 'READY' | 'PENDING' | 'RETRYING' | 'FAILED' | 'NO_TRANSCRIPT' | 'NOT_INTERVIEWED';

interface Status {
  state: State;
  reportId: string | null;
  attempts: number;
  error: string | null;
  nextRetryAt: string | null;
}

/**
 * Shows whether a finished interview has produced a report yet.
 *
 * Report generation can fail transiently (LLM rate limits, a database blip).
 * The scheduler retries automatically, but a recruiter should still be able to
 * see that a report is missing and force another attempt rather than wondering
 * where it went.
 */
export function EvaluationStatus({
  sessionCandidateId,
  candidateStatus,
  hasReport,
  onChanged,
}: {
  sessionCandidateId: string;
  candidateStatus: string;
  hasReport: boolean;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [status, setStatus] = useState<Status | null>(null);
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<Status>(`/interviews/${sessionCandidateId}/evaluation`);
      setStatus(res.data);
    } catch {
      // Non-critical: the row still renders without this.
    }
  }, [sessionCandidateId]);

  // Only interesting once the interview is done and no report exists yet.
  useEffect(() => {
    if (candidateStatus !== 'COMPLETED' || hasReport) return;
    void load();

    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [candidateStatus, hasReport, load]);

  if (candidateStatus !== 'COMPLETED' || hasReport || !status || status.state === 'READY') return null;

  if (status.state === 'NO_TRANSCRIPT') {
    return <Badge tone="neutral">Nothing recorded to evaluate</Badge>;
  }

  const retry = async () => {
    setRetrying(true);
    try {
      await api.post(`/interviews/${sessionCandidateId}/evaluate`);
      toast.success('Report generated');
      onChanged();
    } catch (err) {
      toast.error('Could not generate the report', errorMessage(err));
      void load();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {status.state === 'PENDING' && <Badge tone="info">Generating report…</Badge>}

      {status.state === 'RETRYING' && (
        <Badge tone="warning" title={status.error ?? undefined}>
          Report retrying {status.nextRetryAt ? relativeTime(status.nextRetryAt) : 'soon'}
        </Badge>
      )}

      {status.state === 'FAILED' && (
        <Badge tone="danger" title={status.error ?? undefined}>
          <AlertTriangle className="h-3 w-3" />
          Report failed after {status.attempts} tries
        </Badge>
      )}

      {(status.state === 'FAILED' || status.state === 'RETRYING') && (
        <Button variant="ghost" size="sm" loading={retrying} onClick={retry}>
          <RefreshCw className="h-3.5 w-3.5" />
          Retry now
        </Button>
      )}
    </span>
  );
}
