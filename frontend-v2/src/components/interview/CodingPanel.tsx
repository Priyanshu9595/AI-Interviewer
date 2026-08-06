'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { CheckCircle2, Lightbulb, Play, Send, XCircle } from 'lucide-react';
import { Alert, Badge, Button, Select, Spinner, StatusBadge } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

// Monaco is heavy and browser-only.
const Editor = dynamic(() => import('@monaco-editor/react'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center bg-muted/40">
      <Spinner />
    </div>
  ),
});

export interface CodingChallenge {
  id: string;
  title: string;
  prompt: string;
  constraints: string[];
  starterCode: string;
  difficulty: string;
  skill: string | null;
  sampleTests: Array<{ input: string; output: string }>;
}

interface CaseResult {
  index: number;
  passed: boolean;
  input: string;
  expected: string;
  actual: string;
  stderr?: string;
  timedOut?: boolean;
}

interface RunResponse {
  dryRun?: boolean;
  passed: number;
  total: number;
  compileError?: string;
  unsupported?: string;
  cases: CaseResult[];
  hiddenPassed?: number;
  hiddenTotal?: number;
}

const LANGUAGES = [
  { id: 'javascript', label: 'JavaScript', monaco: 'javascript' },
  { id: 'python', label: 'Python', monaco: 'python' },
  { id: 'cpp', label: 'C++', monaco: 'cpp' },
  { id: 'java', label: 'Java', monaco: 'java' },
];

/** Language-specific scaffolding so nobody loses time on I/O plumbing. */
const STARTERS: Record<string, string> = {
  javascript: `// Input helpers are provided for you:
//   input       full stdin as a string
//   lines[]     stdin split into lines
//   readline()  next line
//   readInts()  next line as an array of numbers
// Print your answer with console.log.

`,
  python: `# Read input with input() or sys.stdin.
# Print your answer with print().

`,
  cpp: `#include <bits/stdc++.h>
using namespace std;

int main() {
    // Read from stdin, write to stdout.
    return 0;
}
`,
  java: `import java.util.*;

public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        // Read from stdin, write to stdout.
    }
}
`,
};

export function CodingPanel({
  token,
  challenge,
  onSubmitted,
}: {
  token: string;
  challenge: CodingChallenge;
  onSubmitted: (summary: { passed: number; total: number }) => void;
}) {
  const [language, setLanguage] = useState('javascript');
  const [code, setCode] = useState(challenge.starterCode || STARTERS.javascript || '');
  const [running, setRunning] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<RunResponse | null>(null);
  const [hint, setHint] = useState('');
  const [hintLoading, setHintLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');

  // Swapping language swaps the scaffold, but never discards real work.
  useEffect(() => {
    const isUntouched = Object.values(STARTERS).some((s) => code.trim() === s.trim()) || code.trim() === '';
    if (isUntouched) setCode(STARTERS[language] ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language]);

  const run = async (dryRun: boolean) => {
    setError('');
    if (dryRun) setRunning(true);
    else setSubmitting(true);

    try {
      const res = await api.post<RunResponse>(`/interview/${token}/code/run`, {
        questionId: challenge.id,
        language,
        code,
        dryRun,
      });

      setResult(res.data);

      if (!dryRun) {
        setSubmitted(true);
        onSubmitted({ passed: res.data.passed, total: res.data.total });
      }
    } catch (err) {
      setError(errorMessage(err, dryRun ? 'Could not run your code' : 'Could not submit your solution'));
    } finally {
      setRunning(false);
      setSubmitting(false);
    }
  };

  const askHint = async () => {
    setHintLoading(true);
    try {
      const res = await api.post<{ hint: string }>(`/interview/${token}/code/hint`, {
        questionId: challenge.id,
        code,
        language,
      });
      setHint(res.data.hint);
    } catch (err) {
      setError(errorMessage(err, 'Could not fetch a hint'));
    } finally {
      setHintLoading(false);
    }
  };

  const monacoLanguage = LANGUAGES.find((l) => l.id === language)?.monaco ?? 'javascript';

  return (
    <div className="grid h-full min-h-0 gap-3 overflow-y-auto lg:grid-cols-2 lg:gap-4 lg:overflow-hidden">
      {/* Problem */}
      <div className="flex min-h-0 flex-col gap-3">
        <div className="card min-h-0 flex-1 overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
            <h3 className="text-sm font-semibold">{challenge.title}</h3>
            <StatusBadge value={challenge.difficulty} />
            {challenge.skill && <Badge tone="primary">{challenge.skill}</Badge>}
          </div>

          <div className="scroll-area max-h-[45vh] space-y-4 p-4 lg:max-h-none">
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{challenge.prompt}</p>

            {challenge.constraints.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Constraints</h4>
                <ul className="mt-1.5 space-y-1 text-sm text-muted-foreground">
                  {challenge.constraints.map((c, i) => (
                    <li key={i}>· {c}</li>
                  ))}
                </ul>
              </div>
            )}

            {challenge.sampleTests.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Examples</h4>
                <div className="mt-2 space-y-2">
                  {challenge.sampleTests.map((t, i) => (
                    <div key={i} className="overflow-guard rounded-md border border-border bg-muted/50 p-3">
                      <div className="grid gap-2 sm:grid-cols-2">
                        <div>
                          <p className="text-xs text-muted-foreground">Input</p>
                          <pre className="mt-0.5 whitespace-pre-wrap font-mono text-xs text-foreground">{t.input}</pre>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">Expected output</p>
                          <pre className="mt-0.5 whitespace-pre-wrap font-mono text-xs text-foreground">{t.output}</pre>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {hint && (
              <Alert tone="info" title="Hint">
                {hint}
              </Alert>
            )}
          </div>
        </div>

        {/* Results */}
        {(result || error) && (
          <div className="card shrink-0">
            <div className="border-b border-border px-4 py-2.5">
              <h4 className="text-sm font-semibold">
                {error ? 'Error' : result?.dryRun ? 'Sample run' : 'Submission result'}
              </h4>
            </div>

            <div className="scroll-area max-h-52 p-4">
              {error && <Alert tone="danger">{error}</Alert>}

              {result?.unsupported && <Alert tone="warning">{result.unsupported}</Alert>}

              {result?.compileError && (
                <Alert tone="danger" title="Compilation failed">
                  <pre className="mt-1 overflow-x-auto whitespace-pre-wrap font-mono text-xs">
                    {result.compileError}
                  </pre>
                </Alert>
              )}

              {result && !result.compileError && !result.unsupported && (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={result.passed === result.total ? 'success' : result.passed > 0 ? 'warning' : 'danger'}>
                      {result.passed} / {result.total} passed
                    </Badge>
                    {result.hiddenTotal ? (
                      <Badge>
                        {result.hiddenPassed} / {result.hiddenTotal} hidden tests passed
                      </Badge>
                    ) : null}
                  </div>

                  {result.cases.map((c) => (
                    <div
                      key={c.index}
                      className={cn(
                        'overflow-guard rounded-md border p-2.5 text-xs',
                        c.passed ? 'border-success/25 bg-success-soft' : 'border-danger/25 bg-danger-soft',
                      )}
                    >
                      <div className="flex items-center gap-1.5 font-medium">
                        {c.passed ? (
                          <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                        ) : (
                          <XCircle className="h-3.5 w-3.5 text-danger" />
                        )}
                        Test {c.index + 1}
                        {c.timedOut && <span className="text-danger">· timed out</span>}
                      </div>

                      {!c.passed && (
                        <div className="mt-1.5 grid gap-1 font-mono text-foreground/80 sm:grid-cols-3">
                          <div>
                            <span className="text-muted-foreground">in: </span>
                            {c.input.replace(/\n/g, ' ⏎ ')}
                          </div>
                          <div>
                            <span className="text-muted-foreground">want: </span>
                            {c.expected}
                          </div>
                          <div>
                            <span className="text-muted-foreground">got: </span>
                            {c.actual || '(nothing)'}
                          </div>
                        </div>
                      )}

                      {c.stderr && (
                        <pre className="mt-1.5 whitespace-pre-wrap font-mono text-[11px] text-danger">{c.stderr}</pre>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Editor */}
      <div className="card flex min-h-0 flex-col overflow-hidden">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
          <Select
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            className="h-8 w-36 text-xs"
            disabled={submitted}
          >
            {LANGUAGES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </Select>

          <div className="flex flex-1 flex-wrap justify-end gap-1.5">
            <Button variant="ghost" size="sm" onClick={askHint} loading={hintLoading} disabled={submitted}>
              <Lightbulb className="h-3.5 w-3.5" />
              Hint
            </Button>
            <Button variant="outline" size="sm" onClick={() => run(true)} loading={running} disabled={submitted}>
              <Play className="h-3.5 w-3.5" />
              Run samples
            </Button>
            <Button size="sm" onClick={() => run(false)} loading={submitting} disabled={submitted}>
              <Send className="h-3.5 w-3.5" />
              {submitted ? 'Submitted' : 'Submit'}
            </Button>
          </div>
        </div>

        <div className="min-h-[16rem] flex-1 sm:min-h-[20rem]">
          <Editor
            height="100%"
            language={monacoLanguage}
            value={code}
            onChange={(v) => setCode(v ?? '')}
            theme="vs"
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 2,
              padding: { top: 12 },
              readOnly: submitted,
              fontFamily: 'var(--font-mono), ui-monospace, monospace',
            }}
          />
        </div>

        {submitted && (
          <div className="shrink-0 border-t border-border px-4 py-2.5">
            <p className="text-xs text-muted-foreground">
              Submitted. The interviewer will continue with the next part shortly.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
