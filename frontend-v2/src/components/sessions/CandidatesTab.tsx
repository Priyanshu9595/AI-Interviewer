'use client';

import { FormEvent, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Copy,
  FileText,
  Download,
  FileSpreadsheet,
  Mail,
  Plus,
  Trash2,
  Upload,
  Users,
} from 'lucide-react';
import { useToast } from '@/components/Toast';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  CardTitle,
  EmptyState,
  Field,
  Input,
  Modal,
  StatusBadge,
  scoreTone,
} from '@/components/ui';
import { EvaluationStatus } from '@/components/sessions/EvaluationStatus';
import { ResumePanel } from '@/components/sessions/ResumePanel';
import { api, errorMessage } from '@/lib/api';
import { avatarColor, cn, initials } from '@/lib/utils';

export interface SessionCandidate {
  id: string;
  accessToken: string;
  status: string;
  identityVerified: boolean;
  joinedAt: string | null;
  completedAt: string | null;
  candidate: { id: string; name: string; email: string; mobile: string | null };
  report: { id: string; overallRating: number; hiringRecommendation: string } | null;
  reminders?: Array<{ kind: string; status: string; sentAt: string | null }>;
  resumeFileName?: string | null;
  resumeParsedAt?: string | null;
}

interface BulkResult {
  inserted: number;
  skipped: number;
  errors: Array<{ row: number; email?: string; message: string }>;
}

const SAMPLE_CSV = 'Name,Email,Mobile\nPriya Sharma,priya@example.com,+91 98765 43210\nArjun Mehta,arjun@example.com,+91 91234 56780\n';

export function CandidatesTab({
  sessionId,
  candidates,
  onChanged,
}: {
  sessionId: string;
  candidates: SessionCandidate[];
  onChanged: () => void;
}) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [resumeFor, setResumeFor] = useState<SessionCandidate | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);
  const [form, setForm] = useState({ name: '', email: '', mobile: '' });

  const addOne = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post(`/sessions/${sessionId}/candidates`, {
        name: form.name,
        email: form.email,
        mobile: form.mobile || undefined,
      });
      toast.success('Candidate added', 'An invitation email has been queued.');
      setForm({ name: '', email: '', mobile: '' });
      setAddOpen(false);
      onChanged();
    } catch (err) {
      toast.error('Could not add candidate', errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const upload = async (file: File) => {
    setUploading(true);
    setBulkResult(null);

    const body = new FormData();
    body.append('file', file);

    try {
      const res = await api.post<BulkResult>(`/sessions/${sessionId}/candidates/bulk`, body, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setBulkResult(res.data);

      if (res.data.inserted > 0) {
        toast.success(
          `${res.data.inserted} candidate${res.data.inserted === 1 ? '' : 's'} added`,
          res.data.skipped > 0 ? `${res.data.skipped} row(s) were skipped.` : 'Invitations have been queued.',
        );
        onChanged();
      } else {
        toast.error('No candidates were added', 'Check the errors listed below.');
      }
    } catch (err) {
      toast.error('Upload failed', errorMessage(err));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const remove = async (row: SessionCandidate) => {
    if (!confirm(`Remove ${row.candidate.name} from this session? Their transcript and report will be deleted.`)) return;

    try {
      await api.delete(`/sessions/${sessionId}/candidates/${row.id}`);
      toast.success('Candidate removed');
      onChanged();
    } catch (err) {
      toast.error('Could not remove candidate', errorMessage(err));
    }
  };

  const resend = async (row: SessionCandidate) => {
    try {
      await api.post(`/sessions/${sessionId}/candidates/${row.id}/resend`);
      toast.success('Invitation re-sent', `Queued for ${row.candidate.email}.`);
      onChanged();
    } catch (err) {
      toast.error('Could not resend the invitation', errorMessage(err));
    }
  };

  const copyLink = async (row: SessionCandidate) => {
    const url = `${window.location.origin}/interview/${row.accessToken}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Interview link copied', 'This link is unique to this candidate.');
    } catch {
      // Clipboard is blocked outside a secure context; show the link instead.
      prompt('Copy this candidate’s interview link:', url);
    }
  };

  const downloadTemplate = () => {
    const blob = new Blob([SAMPLE_CSV], { type: 'text/csv' });
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = 'candidates-template.csv';
    a.click();
    URL.revokeObjectURL(href);
  };

  return (
    <>
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Candidates</CardTitle>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {candidates.length === 0
                ? 'Nobody invited yet.'
                : `${candidates.length} invited · ${candidates.filter((c) => c.status === 'COMPLETED').length} completed`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setBulkOpen(true)}>
              <Upload className="h-4 w-4" />
              Bulk upload
            </Button>
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4" />
              Add candidate
            </Button>
          </div>
        </CardHeader>

        {candidates.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No candidates yet"
            description="Add candidates one at a time, or upload a CSV or Excel file. Each gets a unique interview link and automatic reminders."
            action={
              <div className="flex gap-2">
                <Button size="sm" onClick={() => setAddOpen(true)}>
                  <Plus className="h-4 w-4" />
                  Add candidate
                </Button>
                <Button variant="outline" size="sm" onClick={() => setBulkOpen(true)}>
                  <Upload className="h-4 w-4" />
                  Bulk upload
                </Button>
              </div>
            }
          />
        ) : (
          <ul className="divide-y divide-border">
            {candidates.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                <div
                  className={cn(
                    'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                    avatarColor(row.candidate.name),
                  )}
                >
                  {initials(row.candidate.name)}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-medium text-foreground">{row.candidate.name}</p>
                    <StatusBadge value={row.status} />
                    {row.resumeParsedAt ? (
                      <Badge tone="success">Resume</Badge>
                    ) : (
                      <Badge>No resume</Badge>
                    )}
                    {row.report && (
                      <>
                        <Badge tone={scoreTone(row.report.overallRating)}>{row.report.overallRating.toFixed(1)}</Badge>
                        <StatusBadge value={row.report.hiringRecommendation} />
                      </>
                    )}
                    <EvaluationStatus
                      sessionCandidateId={row.id}
                      candidateStatus={row.status}
                      hasReport={Boolean(row.report)}
                      onChanged={onChanged}
                    />
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {row.candidate.email}
                    {row.candidate.mobile ? ` · ${row.candidate.mobile}` : ''}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  {row.report && (
                    <Link href={`/reports/${row.report.id}`}>
                      <Button variant="outline" size="sm">
                        View report
                      </Button>
                    </Link>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setResumeFor(row)}
                    title={row.resumeParsedAt ? 'View resume' : 'Upload a resume'}
                  >
                    <FileText className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => copyLink(row)} title="Copy interview link">
                    <Copy className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => resend(row)} title="Resend invitation">
                    <Mail className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => remove(row)} title="Remove from session">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {resumeFor && (
        <ResumePanel
          sessionCandidateId={resumeFor.id}
          candidateName={resumeFor.candidate.name}
          open
          onClose={() => setResumeFor(null)}
          onChanged={onChanged}
        />
      )}

      {/* Add one */}
      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add a candidate"
        description="They will receive an invitation with a unique interview link, plus reminders 24 hours, 1 hour and 5 minutes before."
        footer={
          <>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button form="add-candidate" type="submit" loading={saving}>
              Add and invite
            </Button>
          </>
        }
      >
        <form id="add-candidate" onSubmit={addOne} className="space-y-4">
          <Field label="Full name" required>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Priya Sharma"
              required
              autoFocus
            />
          </Field>
          <Field label="Email" required>
            <Input
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              placeholder="priya@example.com"
              required
            />
          </Field>
          <Field label="Mobile" hint="Optional.">
            <Input
              value={form.mobile}
              onChange={(e) => setForm({ ...form, mobile: e.target.value })}
              placeholder="+91 98765 43210"
            />
          </Field>
        </form>
      </Modal>

      {/* Bulk upload */}
      <Modal
        open={bulkOpen}
        onClose={() => {
          setBulkOpen(false);
          setBulkResult(null);
        }}
        title="Bulk upload candidates"
        description="Upload a CSV or Excel file with Name, Email and optionally Mobile columns."
        size="lg"
        footer={
          <Button
            variant="outline"
            onClick={() => {
              setBulkOpen(false);
              setBulkResult(null);
            }}
          >
            Done
          </Button>
        }
      >
        <div className="space-y-4">
          <div className="rounded-md border border-dashed border-border bg-muted/40 p-6 text-center">
            <FileSpreadsheet className="mx-auto h-7 w-7 text-muted-foreground" />
            <p className="mt-2 text-sm font-medium text-foreground">Choose a CSV or Excel file</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Header names are matched loosely — “Full Name”, “Email Address” and “Phone” all work.
            </p>

            <input
              ref={fileRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void upload(file);
              }}
            />

            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <Button size="sm" loading={uploading} onClick={() => fileRef.current?.click()}>
                <Upload className="h-4 w-4" />
                Select file
              </Button>
              <Button variant="outline" size="sm" onClick={downloadTemplate}>
                <Download className="h-4 w-4" />
                Download template
              </Button>
            </div>
          </div>

          {bulkResult && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <Badge tone="success">{bulkResult.inserted} added</Badge>
                {bulkResult.skipped > 0 && <Badge tone="warning">{bulkResult.skipped} skipped</Badge>}
              </div>

              {bulkResult.errors.length > 0 && (
                <Alert tone="warning" title="Some rows could not be imported">
                  <ul className="mt-1.5 max-h-52 space-y-1 overflow-y-auto text-xs">
                    {bulkResult.errors.map((e, i) => (
                      <li key={i}>
                        <span className="font-medium">Row {e.row}</span>
                        {e.email ? ` (${e.email})` : ''}: {e.message}
                      </li>
                    ))}
                  </ul>
                </Alert>
              )}
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}
