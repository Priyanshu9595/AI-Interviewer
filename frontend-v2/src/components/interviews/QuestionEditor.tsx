'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Alert, Badge, Button, Field, Input, Select, Spinner, Textarea } from '@/components/ui';
import { useToast } from '@/components/Toast';
import { api, errorMessage } from '@/lib/api';

const DIFFICULTIES = ['EASY', 'MEDIUM', 'HARD'] as const;

type Category = 'INTRO' | 'HR' | 'TECHNICAL' | 'SCENARIO' | 'PROJECT' | 'CODING';
type Difficulty = (typeof DIFFICULTIES)[number];

interface TestCase {
  input: string;
  output: string;
  hidden?: boolean;
}

interface CodingMeta {
  title?: string;
  constraints?: string[];
  starterCode?: string;
  testCases?: TestCase[];
}

export interface Question {
  id: string;
  content: string;
  category: Category | string;
  difficulty: Difficulty | string;
  skill: string | null;
  expectedAnswer: string | null;
  order: number;
  meta?: CodingMeta | null;
}

interface Props {
  sessionId: string;
  /** False once the interviewer has spoken to anyone; the set is then frozen. */
  editable: boolean;
}

/**
 * Review and change the questions before the interview happens.
 *
 * Generated questions are a starting point, not a verdict — a recruiter who
 * knows the role will always want to cut one and reword another. Doing that
 * after the interview would be worse than useless, so the whole panel goes
 * read-only the moment the interviewer has spoken to anybody.
 *
 * Edits save on blur rather than behind a Save button. There is no draft state
 * to lose and no ambiguity about whether a change took.
 */
export function QuestionEditor({ sessionId, editable }: Props) {
  const toast = useToast();

  const [questions, setQuestions] = useState<Question[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get<{ questionSet?: { questions: Question[] } | null }>(`/sessions/${sessionId}`);
      setQuestions(data.questionSet?.questions ?? []);
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'Could not load the questions'));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Writes one field. The local copy is already current; this persists it. */
  const save = async (id: string, patch: Partial<Question>) => {
    setSavingId(id);
    try {
      await api.patch(`/sessions/${sessionId}/questions/${id}`, patch);
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'Could not save that change'));
      // The server refused, so the screen must stop claiming otherwise.
      await load();
    } finally {
      setSavingId(null);
    }
  };

  const patchLocal = (id: string, patch: Partial<Question>) =>
    setQuestions((qs) => qs.map((q) => (q.id === id ? { ...q, ...patch } : q)));

  const addQuestion = async (category: Category) => {
    setBusy(true);
    try {
      const { data } = await api.post<Question>(`/sessions/${sessionId}/questions`, {
        content:
          category === 'CODING'
            ? 'Write a function that solves the problem described below.'
            : 'New question — replace this text.',
        category,
        difficulty: 'MEDIUM',
        ...(category === 'CODING'
          ? { meta: { title: 'New coding exercise', constraints: [], starterCode: '', testCases: [] } }
          : {}),
      });
      setQuestions((qs) => qs.concat(data));
    } catch (err) {
      setError(errorMessage(err, 'Could not add a question'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    const previous = questions;
    setQuestions((qs) => qs.filter((q) => q.id !== id));
    try {
      await api.delete(`/sessions/${sessionId}/questions/${id}`);
    } catch (err) {
      setQuestions(previous);
      setError(errorMessage(err, 'Could not delete that question'));
    }
  };

  const regenerate = async () => {
    if (!window.confirm('Replace every question with a freshly generated set? Your edits will be lost.')) return;

    setBusy(true);
    try {
      const { data } = await api.post<{ questions: Question[] }>(`/sessions/${sessionId}/questions/generate`);
      setQuestions(data.questions ?? []);
      toast.success('Questions regenerated');
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'Could not regenerate the questions'));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {!editable && (
        <Alert tone="warning" title="These questions are locked">
          The interviewer has already used this set. Changing it now would mean the report was written against
          questions that were never asked.
        </Alert>
      )}

      {error && <Alert tone="danger">{error}</Alert>}

      {editable && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => addQuestion('TECHNICAL')} disabled={busy}>
            <Plus className="h-4 w-4" />
            Add question
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => addQuestion('CODING')} disabled={busy}>
            <Plus className="h-4 w-4" />
            Add coding exercise
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={regenerate} loading={busy}>
            <RefreshCw className="h-4 w-4" />
            Regenerate all
          </Button>
          <span className="text-sm text-muted-foreground">
            {questions.length} question{questions.length === 1 ? '' : 's'}
            {savingId && ' · saving…'}
          </span>
        </div>
      )}

      {questions.length === 0 ? (
        <Alert tone="info">
          No questions yet. They are generated from the job description a few seconds after the interview is created —
          reload in a moment, or add your own.
        </Alert>
      ) : (
        <ol className="space-y-3">
          {questions.map((q, i) => (
            <li key={q.id} className="rounded-lg border border-border bg-surface p-4">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-muted-foreground">#{i + 1}</span>
                <Badge tone={q.category === 'CODING' ? 'info' : 'neutral'}>{String(q.category)}</Badge>

                {editable ? (
                  <Select
                    value={String(q.difficulty)}
                    onChange={(e) => {
                      patchLocal(q.id, { difficulty: e.target.value });
                      void save(q.id, { difficulty: e.target.value });
                    }}
                    className="h-8 w-auto text-xs"
                  >
                    {DIFFICULTIES.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Badge tone="neutral">{String(q.difficulty)}</Badge>
                )}

                {editable && (
                  <button
                    type="button"
                    onClick={() => void remove(q.id)}
                    aria-label={`Delete question ${i + 1}`}
                    className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted hover:text-danger"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>

              <Field label={q.category === 'CODING' ? 'Problem statement' : 'Question'}>
                <Textarea
                  rows={q.category === 'CODING' ? 4 : 2}
                  value={q.content}
                  disabled={!editable}
                  onChange={(e) => patchLocal(q.id, { content: e.target.value })}
                  onBlur={(e) => void save(q.id, { content: e.target.value })}
                />
              </Field>

              {q.category === 'CODING' ? (
                <CodingFields
                  question={q}
                  editable={editable}
                  onLocal={(meta) => patchLocal(q.id, { meta: { ...q.meta, ...meta } })}
                  onSave={(meta) => void save(q.id, { meta: { ...q.meta, ...meta } })}
                />
              ) : (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <Field label="Skill">
                    <Input
                      value={q.skill ?? ''}
                      disabled={!editable}
                      onChange={(e) => patchLocal(q.id, { skill: e.target.value })}
                      onBlur={(e) => void save(q.id, { skill: e.target.value })}
                    />
                  </Field>
                  <Field label="What a good answer covers" hint="Used when scoring. Not read to the candidate.">
                    <Input
                      value={q.expectedAnswer ?? ''}
                      disabled={!editable}
                      onChange={(e) => patchLocal(q.id, { expectedAnswer: e.target.value })}
                      onBlur={(e) => void save(q.id, { expectedAnswer: e.target.value })}
                    />
                  </Field>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * The extra fields a coding exercise carries.
 *
 * Test cases are what the runner grades against, so they are edited as real
 * rows rather than as a blob of JSON — a recruiter should not have to get
 * brackets right to add a case.
 */
function CodingFields({
  question,
  editable,
  onLocal,
  onSave,
}: {
  question: Question;
  editable: boolean;
  onLocal: (meta: CodingMeta) => void;
  onSave: (meta: CodingMeta) => void;
}) {
  const meta = question.meta ?? {};
  const cases = meta.testCases ?? [];

  const setCases = (next: TestCase[], persist: boolean) => {
    onLocal({ testCases: next });
    if (persist) onSave({ testCases: next });
  };

  return (
    <div className="mt-3 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Exercise title">
          <Input
            value={meta.title ?? ''}
            disabled={!editable}
            onChange={(e) => onLocal({ title: e.target.value })}
            onBlur={(e) => onSave({ title: e.target.value })}
          />
        </Field>
        <Field label="Constraints" hint="One per line.">
          <Input
            value={(meta.constraints ?? []).join(' | ')}
            disabled={!editable}
            placeholder="1 <= n <= 10000 | no external libraries"
            onChange={(e) => onLocal({ constraints: splitConstraints(e.target.value) })}
            onBlur={(e) => onSave({ constraints: splitConstraints(e.target.value) })}
          />
        </Field>
      </div>

      <Field label="Starter code" hint="What the candidate's editor opens with.">
        <Textarea
          rows={4}
          className="font-mono text-[13px]"
          value={meta.starterCode ?? ''}
          disabled={!editable}
          onChange={(e) => onLocal({ starterCode: e.target.value })}
          onBlur={(e) => onSave({ starterCode: e.target.value })}
        />
      </Field>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-medium text-foreground">Test cases</p>
          {editable && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setCases(cases.concat({ input: '', output: '', hidden: false }), false)}
            >
              <Plus className="h-4 w-4" />
              Add case
            </Button>
          )}
        </div>

        {cases.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No test cases. Without at least one, a submission cannot be graded automatically.
          </p>
        ) : (
          <div className="space-y-2">
            {cases.map((c, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-center">
                <Input
                  placeholder="Input"
                  className="font-mono text-[13px]"
                  value={c.input}
                  disabled={!editable}
                  onChange={(e) => setCases(cases.map((x, j) => (j === i ? { ...x, input: e.target.value } : x)), false)}
                  onBlur={(e) => setCases(cases.map((x, j) => (j === i ? { ...x, input: e.target.value } : x)), true)}
                />
                <Input
                  placeholder="Expected output"
                  className="font-mono text-[13px]"
                  value={c.output}
                  disabled={!editable}
                  onChange={(e) =>
                    setCases(cases.map((x, j) => (j === i ? { ...x, output: e.target.value } : x)), false)
                  }
                  onBlur={(e) => setCases(cases.map((x, j) => (j === i ? { ...x, output: e.target.value } : x)), true)}
                />
                <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={Boolean(c.hidden)}
                    disabled={!editable}
                    onChange={(e) =>
                      setCases(cases.map((x, j) => (j === i ? { ...x, hidden: e.target.checked } : x)), true)
                    }
                  />
                  Hidden
                </label>
                {editable && (
                  <button
                    type="button"
                    onClick={() => setCases(cases.filter((_, j) => j !== i), true)}
                    aria-label={`Remove test case ${i + 1}`}
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-danger"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Splits on newlines or pipes, so the field works however it is typed into. */
function splitConstraints(value: string): string[] {
  return value
    .split(/[\n|]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
