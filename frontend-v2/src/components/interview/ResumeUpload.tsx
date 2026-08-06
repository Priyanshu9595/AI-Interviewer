'use client';

import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, FileText, Loader2, Upload } from 'lucide-react';
import { Alert, Badge, Button, Card, CardBody } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

interface UploadResult {
  fileName: string;
  characters: number;
  pages?: number;
  skills: string[];
  yearsExperience: number;
  tailoredQuestions: number;
}

/**
 * Candidate-side resume upload, shown before the interview starts.
 *
 * Uploading is optional — the interview runs from the job-description question
 * set either way. A resume just makes the questions specific to this person.
 */
export function ResumeUpload({ token, onUploaded }: { token: string; onUploaded?: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);

  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [existing, setExisting] = useState<{ fileName: string | null } | null>(null);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);

  // A candidate who refreshes should see that their resume is already in.
  useEffect(() => {
    let cancelled = false;

    api
      .get<{ uploaded: boolean; fileName: string | null }>(`/interview/${token}/resume`)
      .then((res) => {
        if (!cancelled && res.data.uploaded) setExisting({ fileName: res.data.fileName });
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [token]);

  const upload = async (file: File) => {
    setError('');

    if (file.size > 10 * 1024 * 1024) {
      setError('That file is larger than 10 MB. Please upload a smaller one.');
      return;
    }

    setUploading(true);
    const body = new FormData();
    body.append('resume', file);

    try {
      const res = await api.post<UploadResult>(`/interview/${token}/resume`, body, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setResult(res.data);
      setExisting(null);
      onUploaded?.();
    } catch (err) {
      setError(errorMessage(err, 'Could not read that resume'));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  if (result) {
    return (
      <Card>
        <CardBody>
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">Resume received</p>
              <p className="mt-0.5 truncate text-sm text-muted-foreground">{result.fileName}</p>

              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {result.yearsExperience > 0 && <Badge tone="primary">{result.yearsExperience} yrs experience</Badge>}
                {result.skills.slice(0, 6).map((s) => (
                  <Badge key={s}>{s}</Badge>
                ))}
                {result.skills.length > 6 && <Badge>+{result.skills.length - 6}</Badge>}
              </div>

              {result.tailoredQuestions > 0 && (
                <p className="mt-2.5 text-xs text-muted-foreground">
                  Your interviewer has prepared {result.tailoredQuestions} question
                  {result.tailoredQuestions === 1 ? '' : 's'} about your own background.
                </p>
              )}
            </div>
          </div>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardBody className="space-y-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <FileText className="h-4 w-4 text-muted-foreground" />
            Your resume
            <span className="font-normal text-muted-foreground">· optional</span>
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Upload it and the interviewer will ask about your actual projects and experience instead of generic
            questions.
          </p>
        </div>

        {existing && (
          <Alert tone="success">
            Already uploaded{existing.fileName ? `: ${existing.fileName}` : ''}. Upload again to replace it.
          </Alert>
        )}

        {error && <Alert tone="danger">{error}</Alert>}

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer.files?.[0];
            if (file) void upload(file);
          }}
          className={`rounded-md border border-dashed p-5 text-center transition-colors ${
            dragging ? 'border-primary bg-primary-soft' : 'border-border bg-muted/40'
          }`}
        >
          {uploading ? (
            <div className="flex flex-col items-center gap-2 py-1">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
              <p className="text-sm font-medium text-foreground">Reading your resume…</p>
              <p className="text-xs text-muted-foreground">This takes a few seconds.</p>
            </div>
          ) : (
            <>
              <Upload className="mx-auto h-5 w-5 text-muted-foreground" />
              <p className="mt-2 text-sm text-foreground">Drop your resume here, or</p>

              <input
                ref={fileRef}
                type="file"
                accept=".pdf,.docx,.doc,.txt,.md,application/pdf"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void upload(file);
                }}
              />

              <Button variant="outline" size="sm" className="mt-2" onClick={() => fileRef.current?.click()}>
                Choose a file
              </Button>

              <p className="mt-2 text-xs text-muted-foreground">
                PDF, DOCX or TXT, up to 10 MB. A scanned image will not work — it needs selectable text.
              </p>
            </>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
