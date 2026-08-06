'use client';

import { useEffect, useState } from 'react';
import { Download, Video } from 'lucide-react';
import { Alert, Button, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { formatClock, formatDateTime } from '@/lib/utils';

interface RecordingInfo {
  url: string;
  storage: 'CLOUDINARY' | 'LOCAL';
  mimeType: string;
  sizeBytes: number;
  durationSeconds: number;
  recordedAt: string;
  candidateName: string;
  sessionTitle: string;
}

/**
 * Plays an interview recording.
 *
 * The URL is fetched from an authenticated endpoint first, because a <video>
 * element cannot send a bearer token — the endpoint returns either a Cloudinary
 * URL or a short-lived signed route for locally stored files.
 */
export function RecordingPlayer({ sessionCandidateId }: { sessionCandidateId: string }) {
  const [info, setInfo] = useState<RecordingInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    api
      .get<RecordingInfo>(`/interviews/${sessionCandidateId}/recording`)
      .then((res) => {
        if (!cancelled) setInfo(res.data);
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err, 'No recording available'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionCandidateId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Spinner className="h-5 w-5" />
      </div>
    );
  }

  if (error || !info) {
    return (
      <div className="py-8 text-center">
        <Video className="mx-auto h-7 w-7 text-muted-foreground" />
        <p className="mt-2 text-sm font-medium text-foreground">No recording</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {error || 'This interview was not recorded, or the upload did not complete.'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <video
        controls
        preload="metadata"
        className="w-full rounded-md bg-foreground/90"
        src={info.url}
        // Recordings are made in the browser and often lack duration metadata
        // until fully buffered; the poster keeps the frame from flashing white.
        playsInline
      >
        Your browser cannot play this recording.
      </video>

      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>
          Recorded {formatDateTime(info.recordedAt)}
          {info.durationSeconds > 0 && ` · ${formatClock(info.durationSeconds)}`}
          {info.sizeBytes > 0 && ` · ${(info.sizeBytes / 1024 / 1024).toFixed(1)} MB`}
          {info.storage === 'LOCAL' && ' · stored locally'}
        </span>

        <a href={info.url} download target="_blank" rel="noopener noreferrer">
          <Button variant="outline" size="sm">
            <Download className="h-4 w-4" />
            Download
          </Button>
        </a>
      </div>

      {info.storage === 'LOCAL' && (
        <Alert tone="info">
          This file is on the server&apos;s local disk and will not survive a redeploy. Configure Cloudinary to store
          recordings durably.
        </Alert>
      )}
    </div>
  );
}
