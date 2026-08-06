'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Ban, Save, Trash2 } from 'lucide-react';
import { useToast } from '@/components/Toast';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Checkbox,
  Field,
  Input,
  Select,
} from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { toDateTimeLocal } from '@/lib/utils';

export interface SessionDetail {
  id: string;
  title: string;
  jobDescription: string;
  skills: string[];
  experienceLevel: string;
  type: string;
  status: string;
  scheduledAt: string;
  durationMinutes: number;
  meetingProvider: string | null;
  meetingLink: string | null;
  personality: string;
  language: string;
  codingEnabled: boolean;
  videoAnalysisEnabled: boolean;
  recordingEnabled: boolean;
  passMark: number;
}

export function SettingsTab({ session, onChanged }: { session: SessionDetail; onChanged: () => void }) {
  const toast = useToast();
  const router = useRouter();

  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    title: session.title,
    scheduledAt: toDateTimeLocal(new Date(session.scheduledAt)),
    durationMinutes: session.durationMinutes,
    passMark: session.passMark,
    personality: session.personality,
    codingEnabled: session.codingEnabled,
    videoAnalysisEnabled: session.videoAnalysisEnabled,
    recordingEnabled: session.recordingEnabled,
  });

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);

    try {
      await api.patch(`/sessions/${session.id}`, {
        ...form,
        scheduledAt: new Date(form.scheduledAt).toISOString(),
      });
      toast.success('Settings saved', 'Pending reminders have been re-timed to match.');
      onChanged();
    } catch (err) {
      toast.error('Could not save settings', errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const cancelSession = async () => {
    if (!confirm('Cancel this session? Pending reminders stop and invited candidates are marked cancelled.')) return;

    try {
      await api.post(`/sessions/${session.id}/cancel`);
      toast.success('Session cancelled');
      onChanged();
    } catch (err) {
      toast.error('Could not cancel the session', errorMessage(err));
    }
  };

  const deleteSession = async () => {
    if (!confirm('Delete this session permanently? All candidates, transcripts and reports will be removed.')) return;

    try {
      await api.delete(`/sessions/${session.id}`);
      toast.success('Session deleted');
      router.push('/sessions');
    } catch (err) {
      toast.error('Could not delete the session', errorMessage(err));
    }
  };

  return (
    <div className="space-y-4">
      <form onSubmit={save}>
        <Card>
          <CardHeader>
            <CardTitle>Session settings</CardTitle>
          </CardHeader>
          <CardBody className="space-y-4">
            <Field label="Title">
              <Input value={form.title} onChange={(e) => set('title', e.target.value)} />
            </Field>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Date and time" className="sm:col-span-2" hint="Changing this re-times the reminder emails.">
                <Input
                  type="datetime-local"
                  value={form.scheduledAt}
                  onChange={(e) => set('scheduledAt', e.target.value)}
                />
              </Field>
              <Field label="Duration">
                <Select
                  value={String(form.durationMinutes)}
                  onChange={(e) => set('durationMinutes', Number(e.target.value))}
                >
                  {[15, 20, 30, 45, 60, 90].map((m) => (
                    <option key={m} value={m}>
                      {m} minutes
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Interviewer personality">
                <Select value={form.personality} onChange={(e) => set('personality', e.target.value)}>
                  <option value="FRIENDLY">Aria · Friendly</option>
                  <option value="NEUTRAL">Ravi · Neutral</option>
                  <option value="FORMAL">Mr. Sharma · Formal</option>
                  <option value="CHALLENGING">Dr. Rao · Challenging</option>
                </Select>
              </Field>
              <Field label="Hiring bar" hint="Overall score needed for a Hire recommendation.">
                <Select value={String(form.passMark)} onChange={(e) => set('passMark', Number(e.target.value))}>
                  {[4, 5, 6, 7, 8].map((m) => (
                    <option key={m} value={m}>
                      {m} / 10
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <div className="space-y-3 border-t border-border pt-4">
              <Checkbox
                label="Coding assessment"
                description="Include a coding challenge executed against real test cases."
                checked={form.codingEnabled}
                onChange={(e) => set('codingEnabled', e.target.checked)}
              />
              <Checkbox
                label="Video confidence analysis"
                description="Aggregate on-camera metrics only. No imagery leaves the candidate's device."
                checked={form.videoAnalysisEnabled}
                onChange={(e) => set('videoAnalysisEnabled', e.target.checked)}
              />
              <Checkbox
                label="Record the session"
                description="Store the recording for later review."
                checked={form.recordingEnabled}
                onChange={(e) => set('recordingEnabled', e.target.checked)}
              />
            </div>

            <div className="flex justify-end border-t border-border pt-4">
              <Button type="submit" loading={saving}>
                <Save className="h-4 w-4" />
                Save changes
              </Button>
            </div>
          </CardBody>
        </Card>
      </form>

      {/* Read-only reference */}
      <Card>
        <CardHeader>
          <CardTitle>Job description</CardTitle>
        </CardHeader>
        <CardBody>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{session.jobDescription}</p>

          <dl className="mt-4 grid gap-3 border-t border-border pt-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Meeting provider</dt>
              <dd className="mt-0.5 text-foreground">{session.meetingProvider ?? 'Built-in room'}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Interview language</dt>
              <dd className="mt-0.5 text-foreground">{session.language}</dd>
            </div>
          </dl>
        </CardBody>
      </Card>

      {/* Danger zone */}
      <Card className="border-danger/25">
        <CardHeader className="border-danger/20">
          <CardTitle className="text-danger">Danger zone</CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">
          {session.status !== 'CANCELLED' && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-foreground">Cancel this session</p>
                <p className="text-sm text-muted-foreground">
                  Stops all pending reminders. Existing reports are kept.
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={cancelSession}>
                <Ban className="h-4 w-4" />
                Cancel session
              </Button>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <div>
              <p className="text-sm font-medium text-foreground">Delete this session</p>
              <p className="text-sm text-muted-foreground">
                Permanently removes every candidate, transcript and report. This cannot be undone.
              </p>
            </div>
            <Button variant="danger" size="sm" onClick={deleteSession}>
              <Trash2 className="h-4 w-4" />
              Delete
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
