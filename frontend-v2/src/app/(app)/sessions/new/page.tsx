'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Sparkles, X } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { useToast } from '@/components/Toast';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Checkbox,
  Field,
  Input,
  Select,
  Textarea,
} from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { toDateTimeLocal } from '@/lib/utils';

interface ConfigOptions {
  providers: Array<{ name: string; configured: boolean }>;
  personalities: Array<{ key: string; name: string; label: string; description: string }>;
  languages: Array<{ code: string; name: string }>;
  experienceLevels: string[];
}

const PROVIDER_LABELS: Record<string, string> = {
  BUILT_IN: 'Built-in interview room',
  GOOGLE_MEET: 'Google Meet',
  ZOOM: 'Zoom',
  MS_TEAMS: 'Microsoft Teams',
};

/** Default to tomorrow morning rather than a time already in the past. */
function defaultSchedule() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(10, 0, 0, 0);
  return toDateTimeLocal(d);
}

export default function NewSessionPage() {
  const router = useRouter();
  const toast = useToast();

  const [config, setConfig] = useState<ConfigOptions | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [skillDraft, setSkillDraft] = useState('');

  const [form, setForm] = useState({
    title: '',
    jobDescription: '',
    skills: [] as string[],
    experienceLevel: 'Mid-level (3-5 years)',
    type: 'MIXED',
    scheduledAt: defaultSchedule(),
    durationMinutes: 30,
    meetingProvider: 'BUILT_IN',
    personality: 'FRIENDLY',
    language: 'en-US',
    codingEnabled: true,
    videoAnalysisEnabled: true,
    recordingEnabled: true,
    passMark: 6,
  });

  useEffect(() => {
    api
      .get<ConfigOptions>('/sessions/config')
      .then((res) => setConfig(res.data))
      .catch((err) => toast.error('Could not load configuration', errorMessage(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const addSkill = () => {
    // Accept comma-separated pastes as well as one-at-a-time entry.
    const parts = skillDraft
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (!parts.length) return;

    setForm((f) => ({
      ...f,
      skills: Array.from(new Set(f.skills.concat(parts))),
    }));
    setSkillDraft('');
  };

  const removeSkill = (skill: string) => set('skills', form.skills.filter((s) => s !== skill));

  const jdLength = form.jobDescription.trim().length;

  const problems = useMemo(() => {
    const list: string[] = [];
    if (form.title.trim().length < 2) list.push('Give the session a title.');
    if (jdLength < 30) list.push(`The job description needs at least 30 characters (currently ${jdLength}).`);
    if (form.skills.length === 0) list.push('Add at least one required skill.');
    return list;
  }, [form.title, form.skills.length, jdLength]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    if (problems.length) {
      setError(problems[0]!);
      return;
    }

    setSubmitting(true);
    try {
      const res = await api.post<{ id: string }>('/sessions', {
        ...form,
        // datetime-local gives a local wall-clock string; send a real instant.
        scheduledAt: new Date(form.scheduledAt).toISOString(),
      });

      toast.success('Session created', 'Interview questions are being generated in the background.');
      router.push(`/sessions/${res.data.id}`);
    } catch (err) {
      setError(errorMessage(err, 'Could not create the session'));
      setSubmitting(false);
    }
  };

  return (
    <>
      <PageHeader
        title="New interview session"
        description="Describe the role and the platform will write the question set for you."
        breadcrumbs={[{ label: 'Sessions', href: '/sessions' }, { label: 'New' }]}
      />

      <form onSubmit={onSubmit} className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}

        {/* Role */}
        <Card>
          <CardHeader>
            <div>
              <CardTitle>The role</CardTitle>
              <p className="mt-0.5 text-sm text-muted-foreground">
                This is what the AI reads to write its questions, so be specific.
              </p>
            </div>
          </CardHeader>
          <CardBody className="space-y-4">
            <Field label="Interview title" required>
              <Input
                value={form.title}
                onChange={(e) => set('title', e.target.value)}
                placeholder="Senior Backend Engineer"
                autoFocus
              />
            </Field>

            <Field
              label="Job description"
              required
              hint={`${jdLength} characters. The more concrete the responsibilities, the sharper the questions.`}
            >
              <Textarea
                value={form.jobDescription}
                onChange={(e) => set('jobDescription', e.target.value)}
                rows={7}
                placeholder="We are hiring a Senior Backend Engineer to own our payments platform. You will design high-throughput services in Node.js, model data in PostgreSQL, and take responsibility for reliability and on-call…"
              />
            </Field>

            <Field label="Required skills" required hint="Press Enter to add. Comma-separated lists work too.">
              <div className="flex gap-2">
                <Input
                  value={skillDraft}
                  onChange={(e) => setSkillDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ',') {
                      e.preventDefault();
                      addSkill();
                    }
                  }}
                  placeholder="Node.js, PostgreSQL, System Design"
                />
                <Button type="button" variant="outline" onClick={addSkill}>
                  Add
                </Button>
              </div>

              {form.skills.length > 0 && (
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {form.skills.map((skill) => (
                    <Badge key={skill} tone="primary" className="pr-1">
                      {skill}
                      <button
                        type="button"
                        onClick={() => removeSkill(skill)}
                        className="rounded-full p-0.5 transition-colors hover:bg-primary/15"
                        aria-label={`Remove ${skill}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Experience level" required>
                <Select value={form.experienceLevel} onChange={(e) => set('experienceLevel', e.target.value)}>
                  {(config?.experienceLevels ?? ['Mid-level (3-5 years)']).map((level) => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Interview type" required>
                <Select value={form.type} onChange={(e) => set('type', e.target.value)}>
                  <option value="TECHNICAL">Technical</option>
                  <option value="HR">HR / Behavioural</option>
                  <option value="MIXED">Mixed</option>
                </Select>
              </Field>
            </div>
          </CardBody>
        </Card>

        {/* Schedule */}
        <Card>
          <CardHeader>
            <CardTitle>Schedule</CardTitle>
          </CardHeader>
          <CardBody className="grid gap-4 sm:grid-cols-3">
            <Field label="Date and time" required className="sm:col-span-2">
              <Input
                type="datetime-local"
                value={form.scheduledAt}
                onChange={(e) => set('scheduledAt', e.target.value)}
              />
            </Field>

            <Field label="Duration" required>
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


          </CardBody>
        </Card>

        {/* Interviewer */}
        <Card>
          <CardHeader>
            <div>
              <CardTitle>The interviewer</CardTitle>
              <p className="mt-0.5 text-sm text-muted-foreground">How the AI conducts itself during the round.</p>
            </div>
          </CardHeader>
          <CardBody className="space-y-4">
            <Field label="Personality">
              <div className="grid gap-2 sm:grid-cols-2">
                {(config?.personalities ?? []).map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => set('personality', p.key)}
                    className={`rounded-md border p-3 text-left transition-colors ${
                      form.personality === p.key
                        ? 'border-primary bg-primary-soft'
                        : 'border-border bg-surface hover:bg-muted'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-foreground">
                        {p.name} · {p.label}
                      </span>
                      {form.personality === p.key && <Check className="h-4 w-4 shrink-0 text-primary" />}
                    </div>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{p.description}</p>
                  </button>
                ))}
              </div>
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Interview language" hint="The AI speaks and writes questions in this language.">
                <Select value={form.language} onChange={(e) => set('language', e.target.value)}>
                  {(config?.languages ?? [{ code: 'en-US', name: 'English' }]).map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.name}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Hiring bar" hint="Overall score a candidate must reach to be recommended.">
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
                description="Adds a coding challenge that runs against real test cases. Skipped for HR-only rounds."
                checked={form.codingEnabled}
                onChange={(e) => set('codingEnabled', e.target.checked)}
              />

              {form.codingEnabled && form.type === 'HR' && (
                <Alert tone="warning">
                  HR-only rounds do not include a coding challenge. Switch the interview type to Technical or Mixed to
                  use it.
                </Alert>
              )}

              {form.codingEnabled && form.type !== 'HR' && form.durationMinutes < 30 && (
                <Alert tone="warning">
                  A coding challenge takes about {Math.min(10, Math.max(6, Math.round(form.durationMinutes * 0.45)))}{' '}
                  minutes, so a {form.durationMinutes}-minute round leaves room for only a couple of spoken questions.
                  Consider 30 minutes or more for a fuller conversation.
                </Alert>
              )}
              <Checkbox
                label="Video confidence analysis"
                description="The browser measures face presence and steadiness locally and sends only aggregate numbers."
                checked={form.videoAnalysisEnabled}
                onChange={(e) => set('videoAnalysisEnabled', e.target.checked)}
              />
              <Checkbox
                label="Record the session"
                description="Stores the interview recording so you can review it alongside the transcript."
                checked={form.recordingEnabled}
                onChange={(e) => set('recordingEnabled', e.target.checked)}
              />
            </div>
          </CardBody>
        </Card>

        {problems.length > 0 && (
          <Alert tone="info" title="Before you can create this session">
            <ul className="mt-1 list-inside list-disc space-y-0.5">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Alert>
        )}

        <div className="flex flex-wrap justify-end gap-2 pb-4">
          <Button type="button" variant="outline" onClick={() => router.back()}>
            Cancel
          </Button>
          <Button type="submit" loading={submitting} disabled={problems.length > 0}>
            <Sparkles className="h-4 w-4" />
            Create session and generate questions
          </Button>
        </div>
      </form>
    </>
  );
}
