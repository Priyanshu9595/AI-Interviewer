'use client';

import { FormEvent, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bot, Video, X } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { useToast } from '@/components/Toast';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardDescription,
  CardTitle,
  Checkbox,
  Field,
  Input,
  Select,
  Textarea,
} from '@/components/ui';
import { CandidateImport, type ImportRow } from '@/components/interviews/CandidateImport';
import { api, errorMessage } from '@/lib/api';
import {
  PLATFORM_LABEL,
  detectPlatform,
  validateMeetingLink,
  type MeetInterview,
} from '@/lib/meetInterview';
import { toDateTimeLocal } from '@/lib/utils';

/** Tomorrow at 10am, so the default is never a time already gone. */
function defaultSchedule() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(10, 0, 0, 0);
  return toDateTimeLocal(d);
}

/** What the server says happened to one row of a bulk import. */
interface BulkResult {
  row: number;
  name: string;
  email: string;
  ok: boolean;
  interviewId?: string;
  error?: string;
}

const EXPERIENCE_LEVELS = [
  'Fresher (0-1 years)',
  'Junior (1-3 years)',
  'Mid-level (3-5 years)',
  'Senior (5-8 years)',
  'Lead (8+ years)',
];

export default function NewMeetInterviewPage() {
  const router = useRouter();
  const toast = useToast();

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [skillDraft, setSkillDraft] = useState('');

  const [mode, setMode] = useState<'one' | 'bulk'>('one');
  const bulk = mode === 'bulk';
  const [importRows, setImportRows] = useState<ImportRow[]>([]);
  /** Per-row outcomes from the last bulk submit, kept so failures stay visible. */
  const [bulkResults, setBulkResults] = useState<BulkResult[] | null>(null);

  const [form, setForm] = useState({
    candidateName: '',
    candidateEmail: '',
    candidateMobile: '',
    jobTitle: '',
    jobDescription: '',
    requiredSkills: [] as string[],
    durationMinutes: 30,
    meetLink: '',
    scheduledAt: defaultSchedule(),
    experienceLevel: 'Mid-level (3-5 years)',
    type: 'MIXED',
    personality: 'FRIENDLY',
    language: 'en-US',
    sendInvite: true,
    codingEnabled: false,
  });

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const addSkill = () => {
    // Recruiters paste comma-separated lists as often as they type one at a time.
    const parts = skillDraft
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (!parts.length) return;
    setForm((f) => ({ ...f, requiredSkills: Array.from(new Set(f.requiredSkills.concat(parts))) }));
    setSkillDraft('');
  };

  const jdLength = form.jobDescription.trim().length;
  const linkError = form.meetLink ? validateMeetingLink(form.meetLink) : null;
  const platform = form.meetLink ? detectPlatform(form.meetLink) : null;

  const problems = useMemo(() => {
    const list: string[] = [];

    if (bulk) {
      if (importRows.length === 0) list.push('Upload a file with at least one candidate.');
      const bad = importRows.filter((r) => Object.keys(r.errors).length > 0).length;
      if (bad) list.push(`${bad} row${bad === 1 ? '' : 's'} still need fixing.`);
      // The form's values are fallbacks in bulk: a row that brought its own is
      // fine on its own, and a row that did not is only bookable if the form
      // supplies what it is missing.
      const orphaned = importRows.filter((r) => !r.meetLink?.trim() && !form.meetLink.trim()).length;
      if (orphaned) list.push(`${orphaned} row(s) have no meeting link, and none is set below.`);
      const noTitle = importRows.filter((r) => !r.jobTitle?.trim()).length;
      if (noTitle && form.jobTitle.trim().length < 2) {
        list.push(`${noTitle} row(s) have no job title, and none is set below.`);
      }
      const noJd = importRows.filter((r) => !r.jobDescription?.trim()).length;
      if (noJd && jdLength < 30) {
        list.push(`${noJd} row(s) have no job description, and the one below is under 30 characters.`);
      }
      const noSkills = importRows.filter((r) => !r.requiredSkills?.trim()).length;
      if (noSkills && form.requiredSkills.length === 0) {
        list.push(`${noSkills} row(s) have no required skills, and none are set below.`);
      }
    } else {
      if (form.candidateName.trim().length < 2) list.push('Enter the candidate’s name.');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.candidateEmail.trim())) list.push('Enter a valid candidate email.');
      if (form.jobTitle.trim().length < 2) list.push('Enter the job title.');
      if (jdLength < 30) list.push(`The job description needs at least 30 characters (currently ${jdLength}).`);
      if (form.requiredSkills.length === 0) list.push('Add at least one required skill.');
    }

    // In bulk the batch link is a fallback, so an empty one is fine — rows may
    // each carry their own. A bad one is never fine.
    const link = bulk && !form.meetLink.trim() ? null : validateMeetingLink(form.meetLink);
    if (link) list.push(link);

    return list;
  }, [
    bulk,
    importRows,
    form.candidateName,
    form.candidateEmail,
    form.jobTitle,
    form.requiredSkills.length,
    form.meetLink,
    jdLength,
  ]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    if (problems.length) {
      setError(problems[0]!);
      return;
    }

    setSubmitting(true);
    setBulkResults(null);
    try {
      // datetime-local has no zone; the browser's own offset is the one the
      // recruiter meant.
      const scheduledAt = form.scheduledAt ? new Date(form.scheduledAt).toISOString() : '';

      if (bulk) {
        const { data } = await api.post<{ created: number; failed: number; results: BulkResult[] }>(
          '/interviews/bulk',
          {
            ...form,
            scheduledAt,
            // A row is its import fields plus any per-row overrides the file
            // carried; only the client-side error map stays behind.
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            candidates: importRows.map(({ errors, ...r }) => r),
          },
        );

        setBulkResults(data.results);

        if (data.failed === 0) {
          toast.success('Interviews scheduled', `${data.created} interview${data.created === 1 ? '' : 's'} booked.`);
          router.push('/ai-interviews');
          return;
        }

        // Stay on the page. The rows that worked are booked and gone from the
        // list; what is left is exactly what still needs attention.
        setImportRows((rows) =>
          rows.filter((r) => !data.results.some((res) => res.ok && res.row === r.row && res.email === r.email)),
        );
        setError(`${data.created} booked, ${data.failed} could not be. See the list below.`);
        return;
      }

      const { data } = await api.post<MeetInterview>('/interviews', { ...form, scheduledAt });

      toast.success('Interview scheduled', `The AI interviewer will join the meeting shortly before ${new Date(data.scheduledAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.`);
      router.push(`/ai-interviews/${data.id}`);
    } catch (err) {
      setError(errorMessage(err, bulk ? 'Could not book those interviews' : 'Could not schedule the interview'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Create AI interview"
        description="Paste a Google Meet link you have already created. The AI interviewer joins it, runs the interview and files a report."
        breadcrumbs={[{ label: 'AI interviews', href: '/ai-interviews' }, { label: 'New' }]}
      />

      <form onSubmit={onSubmit} className="space-y-4">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>{bulk ? 'Candidates' : 'Candidate'}</CardTitle>
              <CardDescription>
                {bulk
                  ? 'One interview is booked per row. The file can carry its own job title, description, skills, timings and interviewer settings per row — anything it leaves blank uses the form below.'
                  : 'Who is being interviewed, and where they are told to go.'}
              </CardDescription>
            </div>
            <div className="flex rounded-md border border-border p-0.5">
              {(
                [
                  ['one', 'One candidate'],
                  ['bulk', 'Bulk upload'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setMode(value)}
                  className={
                    'rounded px-3 py-1 text-sm font-medium transition-colors ' +
                    (mode === value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          </CardHeader>
          {bulk ? (
            <CardBody>
              <CandidateImport
                rows={importRows}
                onChange={setImportRows}
                fallbackMeetLink={form.meetLink}
                fallbackScheduledAt={form.scheduledAt}
              />
            </CardBody>
          ) : (
            <CardBody className="grid gap-4 sm:grid-cols-2">
              <Field label="Candidate name" required>
                <Input
                  value={form.candidateName}
                  onChange={(e) => set('candidateName', e.target.value)}
                  placeholder="Priyanshu Raj"
                  autoComplete="off"
                />
              </Field>

              <Field label="Candidate email" required hint="Receives the invitation and reminders.">
                <Input
                  type="email"
                  value={form.candidateEmail}
                  onChange={(e) => set('candidateEmail', e.target.value)}
                  placeholder="candidate@example.com"
                  autoComplete="off"
                />
              </Field>

              <Field label="Mobile number" hint="Optional. So you can reach them if they do not turn up.">
                <Input
                  value={form.candidateMobile}
                  onChange={(e) => set('candidateMobile', e.target.value)}
                  placeholder="+91 98765 43210"
                  autoComplete="off"
                />
              </Field>
            </CardBody>
          )}
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Role</CardTitle>
              <CardDescription>
                {bulk
                  ? 'Used for rows whose file did not bring its own job title, description or skills. Leave blank if every row has them.'
                  : 'The questions are generated from this, so specifics pay off.'}
              </CardDescription>
            </div>
          </CardHeader>
          <CardBody className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Job title" required={!bulk}>
                <Input
                  value={form.jobTitle}
                  onChange={(e) => set('jobTitle', e.target.value)}
                  placeholder="Frontend Developer"
                />
              </Field>

              <Field label="Experience level">
                <Select value={form.experienceLevel} onChange={(e) => set('experienceLevel', e.target.value)}>
                  {EXPERIENCE_LEVELS.map((level) => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <Field
              label="Job description"
              required={!bulk}
              hint={`${jdLength} characters — at least 30 needed for useful questions.`}
            >
              <Textarea
                rows={5}
                value={form.jobDescription}
                onChange={(e) => set('jobDescription', e.target.value)}
                placeholder="What the person will actually do, the systems they will work on, and what a strong candidate looks like."
              />
            </Field>

            <Field label="Required skills" required={!bulk} hint="Press Enter to add. Comma-separated lists work too.">
              <div className="space-y-2">
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
                    placeholder="React, TypeScript, Node.js"
                  />
                  <Button type="button" variant="outline" onClick={addSkill}>
                    Add
                  </Button>
                </div>

                {form.requiredSkills.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {form.requiredSkills.map((skill) => (
                      <Badge key={skill} tone="primary" className="gap-1 pr-1.5">
                        {skill}
                        <button
                          type="button"
                          onClick={() =>
                            set('requiredSkills', form.requiredSkills.filter((s) => s !== skill))
                          }
                          className="rounded-full p-0.5 transition-colors hover:bg-indigo-200/60"
                          aria-label={`Remove ${skill}`}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            </Field>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Meeting</CardTitle>
              <CardDescription>
                The AI joins {'—'} it does not create the meeting. Set it up in your own calendar first, then
                paste the link here. Google Meet, Zoom and Microsoft Teams are all supported.
              </CardDescription>
            </div>
          </CardHeader>
          <CardBody className="space-y-4">
            <Field
              label={bulk ? 'Meeting link for rows without one' : 'Existing meeting link'}
              required={!bulk}
              error={linkError ?? undefined}
              hint={
                linkError
                  ? undefined
                  : platform
                    ? `Recognised as a ${PLATFORM_LABEL[platform]} link.`
                    : bulk
                      ? 'Used only where the file left the column blank. Leave empty if every row has its own.'
                      : 'Google Meet, Zoom or Microsoft Teams'
              }
            >
              <div className="relative">
                <Video className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={form.meetLink}
                  onChange={(e) => set('meetLink', e.target.value)}
                  placeholder="https://meet.google.com/abc-defg-hij"
                  className="pl-9 font-mono text-[13px]"
                  autoComplete="off"
                  spellCheck={false}
                />
                {platform && !linkError && (
                  <Badge tone="success" className="absolute right-2 top-1/2 -translate-y-1/2">
                    {PLATFORM_LABEL[platform]}
                  </Badge>
                )}
              </div>
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label={bulk ? 'Time for rows without one' : 'Scheduled time'}
                required={!bulk}
                hint={
                  bulk
                    ? 'Used only where the file left the column blank.'
                    : 'The interviewer joins the meeting at this time.'
                }
              >
                <Input
                  type="datetime-local"
                  value={form.scheduledAt}
                  onChange={(e) => set('scheduledAt', e.target.value)}
                />
              </Field>

              <Field label="Interview duration">
                <Select
                  value={String(form.durationMinutes)}
                  onChange={(e) => set('durationMinutes', Number(e.target.value))}
                >
                  {[15, 20, 30, 45, 60, 90].map((mins) => (
                    <option key={mins} value={mins}>
                      {mins} minutes
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <Alert tone="info">
              If the meeting uses a lobby or waiting room, someone has to let the interviewer in. It waits and the
              status here shows <span className="font-medium">Waiting for admission</span> until it is admitted.
              {platform === 'MS_TEAMS' && ' Teams meetings must also allow anonymous guests to join.'}
              {platform === 'ZOOM' && ' Zoom meetings must not be restricted to signed-in users.'}
            </Alert>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Interviewer</CardTitle>
              <CardDescription>Tone and focus. Sensible defaults if you skip this.</CardDescription>
            </div>
          </CardHeader>
          <CardBody className="grid gap-4 sm:grid-cols-3">
            <Field label="Interview type">
              <Select value={form.type} onChange={(e) => set('type', e.target.value)}>
                <option value="MIXED">Mixed</option>
                <option value="TECHNICAL">Technical</option>
                <option value="HR">Behavioural</option>
              </Select>
            </Field>

            <Field label="Personality">
              <Select value={form.personality} onChange={(e) => set('personality', e.target.value)}>
                <option value="FRIENDLY">Friendly</option>
                <option value="NEUTRAL">Neutral</option>
                <option value="FORMAL">Formal</option>
                <option value="CHALLENGING">Challenging</option>
              </Select>
            </Field>

            <Field label="Language" hint="The interviewer speaks, listens and evaluates in this language.">
              <Select value={form.language} onChange={(e) => set('language', e.target.value)}>
                <option value="en-US">English (US)</option>
                <option value="en-GB">English (UK)</option>
                <option value="en-IN">English (India)</option>
                <option value="hi-IN">Hindi</option>
                <option value="te-IN">Telugu</option>
                <option value="ta-IN">Tamil</option>
                <option value="bn-IN">Bengali</option>
                <option value="mr-IN">Marathi</option>
                <option value="es-ES">Spanish</option>
                <option value="fr-FR">French</option>
                <option value="de-DE">German</option>
                <option value="pt-BR">Portuguese</option>
                <option value="ja-JP">Japanese</option>
                <option value="zh-CN">Mandarin Chinese</option>
                <option value="ar-SA">Arabic</option>
              </Select>
            </Field>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Coding round</CardTitle>
              <CardDescription>Optional. Adds a live coding exercise to the interview.</CardDescription>
            </div>
          </CardHeader>
          <CardBody className="space-y-3">
            <Checkbox
              label="Include a coding exercise"
              description="A meeting call has no shared editor, so the candidate opens a code editor in their browser. The link is emailed with the invitation and posted in the meeting chat when the round begins."
              checked={form.codingEnabled}
              onChange={(e) => set('codingEnabled', e.target.checked)}
            />

            {form.codingEnabled && (
              <Alert tone="info">
                The interviewer stays in the meeting while the candidate writes their solution, and picks the
                conversation back up as soon as it is submitted. Ask the candidate to keep the meeting open and talk
                through their thinking.
              </Alert>
            )}
          </CardBody>
        </Card>

        {error && <Alert tone="danger">{error}</Alert>}

        {bulkResults && bulkResults.some((r) => !r.ok) && (
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Rows that could not be booked</CardTitle>
                <CardDescription>
                  Everything else is already scheduled. Fix these above and submit again — only what is still listed
                  will be sent.
                </CardDescription>
              </div>
            </CardHeader>
            <CardBody className="space-y-2">
              {bulkResults
                .filter((r) => !r.ok)
                .map((r) => (
                  <div key={`${r.row}-${r.email}`} className="rounded-md border border-danger/20 bg-danger-soft px-3 py-2">
                    <p className="text-sm font-medium text-foreground">
                      Row {r.row}: {r.name || r.email}
                    </p>
                    <p className="text-sm text-danger">{r.error}</p>
                  </div>
                ))}
            </CardBody>
          </Card>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 pb-6">
          <p className="text-xs text-muted-foreground">
            <Bot className="mr-1 inline h-3.5 w-3.5" />
            Questions are generated from the job description as soon as this is saved.
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => router.back()}>
              Cancel
            </Button>
            <Button type="submit" loading={submitting} disabled={problems.length > 0}>
              {bulk
                ? `Schedule ${importRows.length || ''} interview${importRows.length === 1 ? '' : 's'}`.replace('  ', ' ')
                : 'Schedule interview'}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
