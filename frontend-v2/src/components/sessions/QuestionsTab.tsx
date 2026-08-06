'use client';

import { FormEvent, useState } from 'react';
import { HelpCircle, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useToast } from '@/components/Toast';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  StatusBadge,
  Textarea,
} from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

export interface Question {
  id: string;
  content: string;
  order: number;
  category: string;
  difficulty: string;
  skill: string | null;
  expectedAnswer: string | null;
  meta: Record<string, unknown> | null;
}

const CATEGORY_LABELS: Record<string, string> = {
  INTRO: 'Introduction',
  IDENTITY: 'Identity check',
  HR: 'Behavioural',
  TECHNICAL: 'Technical',
  SCENARIO: 'Scenario',
  PROJECT: 'Project deep-dive',
  CODING: 'Coding',
  CLOSING: 'Closing',
};

const ORDER = ['INTRO', 'HR', 'TECHNICAL', 'SCENARIO', 'PROJECT', 'CODING', 'IDENTITY', 'CLOSING'];

export function QuestionsTab({
  sessionId,
  questions,
  onChanged,
}: {
  sessionId: string;
  questions: Question[];
  onChanged: () => void;
}) {
  const toast = useToast();
  const [regenerating, setRegenerating] = useState(false);
  const [editing, setEditing] = useState<Question | null>(null);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);

  const [editForm, setEditForm] = useState({ content: '', expectedAnswer: '', difficulty: 'MEDIUM', skill: '' });
  const [newForm, setNewForm] = useState({ content: '', category: 'TECHNICAL', difficulty: 'MEDIUM', skill: '', expectedAnswer: '' });

  const grouped = ORDER.map((category) => ({
    category,
    items: questions.filter((q) => q.category === category),
  })).filter((g) => g.items.length > 0);

  const regenerate = async () => {
    if (questions.length > 0 && !confirm('Regenerate the whole question set? Any edits you have made will be replaced.')) {
      return;
    }

    setRegenerating(true);
    try {
      await api.post(`/sessions/${sessionId}/questions/generate`);
      toast.success('Questions regenerated');
      onChanged();
    } catch (err) {
      toast.error('Could not generate questions', errorMessage(err));
    } finally {
      setRegenerating(false);
    }
  };

  const openEdit = (q: Question) => {
    setEditForm({
      content: q.content,
      expectedAnswer: q.expectedAnswer ?? '',
      difficulty: q.difficulty,
      skill: q.skill ?? '',
    });
    setEditing(q);
  };

  const saveEdit = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;

    setSaving(true);
    try {
      await api.patch(`/sessions/${sessionId}/questions/${editing.id}`, {
        content: editForm.content,
        expectedAnswer: editForm.expectedAnswer || undefined,
        difficulty: editForm.difficulty,
        skill: editForm.skill || undefined,
      });
      toast.success('Question updated');
      setEditing(null);
      onChanged();
    } catch (err) {
      toast.error('Could not update the question', errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const addQuestion = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post(`/sessions/${sessionId}/questions`, {
        content: newForm.content,
        category: newForm.category,
        difficulty: newForm.difficulty,
        skill: newForm.skill || undefined,
        expectedAnswer: newForm.expectedAnswer || undefined,
      });
      toast.success('Question added');
      setNewForm({ content: '', category: 'TECHNICAL', difficulty: 'MEDIUM', skill: '', expectedAnswer: '' });
      setAdding(false);
      onChanged();
    } catch (err) {
      toast.error('Could not add the question', errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (q: Question) => {
    if (!confirm('Delete this question?')) return;
    try {
      await api.delete(`/sessions/${sessionId}/questions/${q.id}`);
      toast.success('Question deleted');
      onChanged();
    } catch (err) {
      toast.error('Could not delete the question', errorMessage(err));
    }
  };

  return (
    <>
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Question set</CardTitle>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {questions.length === 0
                ? 'No questions generated yet.'
                : `${questions.length} questions across ${grouped.length} round${grouped.length === 1 ? '' : 's'}. The AI asks these in order and adds its own follow-ups.`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" />
              Add
            </Button>
            <Button variant="outline" size="sm" loading={regenerating} onClick={regenerate}>
              <RefreshCw className="h-4 w-4" />
              Regenerate
            </Button>
          </div>
        </CardHeader>

        {questions.length === 0 ? (
          <EmptyState
            icon={HelpCircle}
            title="No questions yet"
            description="Generation runs in the background when a session is created. If it has not appeared, generate it now."
            action={
              <Button size="sm" loading={regenerating} onClick={regenerate}>
                <RefreshCw className="h-4 w-4" />
                Generate questions
              </Button>
            }
          />
        ) : (
          <CardBody className="space-y-6">
            {grouped.map(({ category, items }) => (
              <section key={category}>
                <div className="mb-2.5 flex items-center gap-2">
                  <h4 className="text-sm font-semibold text-foreground">{CATEGORY_LABELS[category] ?? category}</h4>
                  <Badge>{items.length}</Badge>
                </div>

                <ul className="space-y-2">
                  {items.map((q, i) => (
                    <li key={q.id} className="group rounded-md border border-border p-3.5">
                      <div className="flex items-start gap-3">
                        <span className="mt-0.5 font-mono text-xs text-muted-foreground">{i + 1}</span>

                        <div className="min-w-0 flex-1">
                          <p className="text-sm leading-relaxed text-foreground">{q.content}</p>

                          <div className="mt-2 flex flex-wrap items-center gap-1.5">
                            <StatusBadge value={q.difficulty} />
                            {q.skill && <Badge tone="primary">{q.skill}</Badge>}
                          </div>

                          {q.expectedAnswer && (
                            <details className="mt-2">
                              <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
                                What a good answer covers
                              </summary>
                              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{q.expectedAnswer}</p>
                            </details>
                          )}

                          {category === 'CODING' && Array.isArray((q.meta as { testCases?: unknown[] })?.testCases) && (
                            <p className="mt-2 text-xs text-muted-foreground">
                              {((q.meta as { testCases: unknown[] }).testCases).length} test case(s) configured
                            </p>
                          )}
                        </div>

                        <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                          <Button variant="ghost" size="icon" onClick={() => openEdit(q)} title="Edit">
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" onClick={() => remove(q)} title="Delete">
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </CardBody>
        )}
      </Card>

      {/* Edit */}
      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title="Edit question"
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button form="edit-question" type="submit" loading={saving}>
              Save
            </Button>
          </>
        }
      >
        <form id="edit-question" onSubmit={saveEdit} className="space-y-4">
          <Field label="Question" hint="Write it the way it should be spoken aloud." required>
            <Textarea
              value={editForm.content}
              onChange={(e) => setEditForm({ ...editForm, content: e.target.value })}
              rows={4}
              required
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Difficulty">
              <Select
                value={editForm.difficulty}
                onChange={(e) => setEditForm({ ...editForm, difficulty: e.target.value })}
              >
                <option value="EASY">Easy</option>
                <option value="MEDIUM">Medium</option>
                <option value="HARD">Hard</option>
              </Select>
            </Field>
            <Field label="Skill">
              <Input value={editForm.skill} onChange={(e) => setEditForm({ ...editForm, skill: e.target.value })} />
            </Field>
          </div>

          <Field label="What a good answer covers" hint="Used for scoring. Never read out to the candidate.">
            <Textarea
              value={editForm.expectedAnswer}
              onChange={(e) => setEditForm({ ...editForm, expectedAnswer: e.target.value })}
              rows={3}
            />
          </Field>
        </form>
      </Modal>

      {/* Add */}
      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title="Add a question"
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button form="add-question" type="submit" loading={saving}>
              Add question
            </Button>
          </>
        }
      >
        <form id="add-question" onSubmit={addQuestion} className="space-y-4">
          <Field label="Question" required>
            <Textarea
              value={newForm.content}
              onChange={(e) => setNewForm({ ...newForm, content: e.target.value })}
              rows={4}
              placeholder="Walk me through a time you had to debug something in production under pressure."
              required
              autoFocus
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Round">
              <Select value={newForm.category} onChange={(e) => setNewForm({ ...newForm, category: e.target.value })}>
                {['INTRO', 'HR', 'TECHNICAL', 'SCENARIO', 'PROJECT'].map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABELS[c]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Difficulty">
              <Select value={newForm.difficulty} onChange={(e) => setNewForm({ ...newForm, difficulty: e.target.value })}>
                <option value="EASY">Easy</option>
                <option value="MEDIUM">Medium</option>
                <option value="HARD">Hard</option>
              </Select>
            </Field>
            <Field label="Skill">
              <Input
                value={newForm.skill}
                onChange={(e) => setNewForm({ ...newForm, skill: e.target.value })}
                placeholder="Node.js"
              />
            </Field>
          </div>

          <Field label="What a good answer covers">
            <Textarea
              value={newForm.expectedAnswer}
              onChange={(e) => setNewForm({ ...newForm, expectedAnswer: e.target.value })}
              rows={3}
            />
          </Field>
        </form>
      </Modal>
    </>
  );
}
