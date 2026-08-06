'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ExternalLink, FileText, Target, Upload } from 'lucide-react';
import { useToast } from '@/components/Toast';
import { Alert, Badge, Button, Modal, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';

interface ResumeProfile {
  fullName: string;
  headline: string;
  totalYearsExperience: number;
  skills: string[];
  roles: Array<{ title: string; company: string; duration: string; highlights: string[] }>;
  projects: Array<{ name: string; description: string; tech: string[] }>;
  education: string[];
  certifications: string[];
  missingJdSkills: string[];
  claimsToProbe: string[];
  gaps: string[];
}

interface ResumeData {
  resumeFileName: string | null;
  resumeMimeType: string | null;
  resumeSizeBytes: number | null;
  resumeProfile: ResumeProfile | null;
  resumeQuestions: Array<{ text: string; probes?: string }> | null;
  resumeParsedAt: string | null;
  candidate: { name: string };
}

/** Recruiter view of a candidate's parsed resume, with an upload fallback. */
export function ResumePanel({
  sessionCandidateId,
  candidateName,
  open,
  onClose,
  onChanged,
}: {
  sessionCandidateId: string;
  candidateName: string;
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const [data, setData] = useState<ResumeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (!open) return;

    setLoading(true);
    setMissing(false);

    api
      .get<ResumeData>(`/interviews/${sessionCandidateId}/resume`)
      .then((res) => setData(res.data))
      .catch(() => setMissing(true))
      .finally(() => setLoading(false));
  }, [open, sessionCandidateId]);

  const upload = async (file: File) => {
    setUploading(true);
    const body = new FormData();
    body.append('resume', file);

    try {
      await api.post(`/interviews/${sessionCandidateId}/resume`, body, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      toast.success('Resume parsed', 'Tailored questions have been prepared for this candidate.');

      const res = await api.get<ResumeData>(`/interviews/${sessionCandidateId}/resume`);
      setData(res.data);
      setMissing(false);
      onChanged();
    } catch (err) {
      toast.error('Could not read that resume', errorMessage(err));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  /** Fetches the stored file with auth, then opens it in a new tab. */
  const openOriginal = async () => {
    setOpening(true);
    try {
      const res = await api.get(`/interviews/${sessionCandidateId}/resume/file`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data as Blob);
      window.open(url, '_blank', 'noopener,noreferrer');
      // Give the new tab time to load before releasing the object URL.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      toast.error('Could not open the resume', errorMessage(err));
    } finally {
      setOpening(false);
    }
  };

  const profile = data?.resumeProfile;

  return (
    <Modal open={open} onClose={onClose} title={`${candidateName} — resume`} size="lg">
      <input
        ref={fileRef}
        type="file"
        accept=".pdf,.docx,.doc,.txt,.md"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
        }}
      />

      {loading ? (
        <div className="flex justify-center py-10">
          <Spinner className="h-5 w-5" />
        </div>
      ) : missing || !profile ? (
        <div className="space-y-4 py-4 text-center">
          <FileText className="mx-auto h-7 w-7 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium text-foreground">No resume yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              The candidate can upload one before their interview, or you can add it here.
            </p>
          </div>
          <Button size="sm" loading={uploading} onClick={() => fileRef.current?.click()}>
            <Upload className="h-4 w-4" />
            Upload a resume
          </Button>
        </div>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              {profile.headline && <p className="text-sm font-medium text-foreground">{profile.headline}</p>}
              <p className="text-xs text-muted-foreground">
                {data?.resumeFileName}
                {data?.resumeSizeBytes ? ` · ${(data.resumeSizeBytes / 1024).toFixed(0)} KB` : ''}
                {data?.resumeParsedAt ? ` · parsed ${formatDateTime(data.resumeParsedAt)}` : ''}
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" loading={opening} onClick={openOriginal}>
                <ExternalLink className="h-4 w-4" />
                Original
              </Button>
              <Button variant="outline" size="sm" loading={uploading} onClick={() => fileRef.current?.click()}>
                <Upload className="h-4 w-4" />
                Replace
              </Button>
            </div>
          </div>

          {profile.totalYearsExperience > 0 && (
            <Badge tone="primary">{profile.totalYearsExperience} years of experience</Badge>
          )}

          {profile.skills.length > 0 && (
            <section>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Skills claimed</h4>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {profile.skills.map((s) => (
                  <Badge key={s}>{s}</Badge>
                ))}
              </div>
            </section>
          )}

          {profile.missingJdSkills.length > 0 && (
            <Alert tone="warning" title="Required skills with no resume evidence">
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {profile.missingJdSkills.map((s) => (
                  <Badge key={s} tone="warning">
                    {s}
                  </Badge>
                ))}
              </div>
            </Alert>
          )}

          {profile.claimsToProbe.length > 0 && (
            <section>
              <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Target className="h-3.5 w-3.5" />
                Claims the interviewer will verify
              </h4>
              <ul className="mt-2 space-y-1.5 text-sm text-foreground">
                {profile.claimsToProbe.map((c, i) => (
                  <li key={i}>· {c}</li>
                ))}
              </ul>
            </section>
          )}

          {data?.resumeQuestions && data.resumeQuestions.length > 0 && (
            <section>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Questions written for this candidate
              </h4>
              <ul className="mt-2 space-y-2">
                {data.resumeQuestions.map((q, i) => (
                  <li key={i} className="rounded-md border border-border p-3">
                    <p className="text-sm text-foreground">{q.text}</p>
                    {q.probes && <p className="mt-1 text-xs text-muted-foreground">Verifies: {q.probes}</p>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {profile.roles.length > 0 && (
            <section>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Experience</h4>
              <ul className="mt-2 space-y-2.5">
                {profile.roles.map((r, i) => (
                  <li key={i}>
                    <p className="text-sm font-medium text-foreground">
                      {r.title}
                      {r.company ? ` · ${r.company}` : ''}
                    </p>
                    {r.duration && <p className="text-xs text-muted-foreground">{r.duration}</p>}
                    {r.highlights.length > 0 && (
                      <ul className="mt-1 space-y-0.5 text-sm text-muted-foreground">
                        {r.highlights.slice(0, 3).map((h, j) => (
                          <li key={j}>· {h}</li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {profile.projects.length > 0 && (
            <section>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Projects</h4>
              <ul className="mt-2 space-y-2">
                {profile.projects.map((p, i) => (
                  <li key={i}>
                    <p className="text-sm font-medium text-foreground">{p.name}</p>
                    {p.description && <p className="text-sm text-muted-foreground">{p.description}</p>}
                    {p.tech.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {p.tech.map((t) => (
                          <Badge key={t}>{t}</Badge>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {profile.gaps.length > 0 && (
            <Alert tone="info" title="Timeline gaps">
              <ul className="mt-1 space-y-1">
                {profile.gaps.map((g, i) => (
                  <li key={i}>· {g}</li>
                ))}
              </ul>
            </Alert>
          )}

          {(profile.education.length > 0 || profile.certifications.length > 0) && (
            <section className="border-t border-border pt-4 text-sm text-muted-foreground">
              {profile.education.length > 0 && <p>Education: {profile.education.join('; ')}</p>}
              {profile.certifications.length > 0 && <p>Certifications: {profile.certifications.join('; ')}</p>}
            </section>
          )}

          <p className="flex items-start gap-1.5 border-t border-border pt-4 text-xs text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Extracted automatically from the uploaded file. Scores come from the interview itself, not from this
            resume — it only shapes which questions get asked.
          </p>
        </div>
      )}
    </Modal>
  );
}
