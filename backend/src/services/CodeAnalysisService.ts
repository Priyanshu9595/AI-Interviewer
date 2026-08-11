import { z } from 'zod';
import { complete, completeJson, FAST_MODEL, SMART_MODEL } from '../lib/ai';
import { env } from '../lib/env';
import type { ExecutionResult } from './CodeExecutorService';

const reviewSchema = z.object({
  timeComplexity: z.string().default('Unknown'),
  spaceComplexity: z.string().default('Unknown'),
  qualityScore: z.number().min(0).max(10).default(5),
  readability: z.number().min(0).max(10).default(5),
  approach: z.string().default(''),
  feedback: z.string().default(''),
  improvements: z.array(z.string()).default([]),
  matchesOptimal: z.boolean().default(false),
});

export type CodeReview = z.infer<typeof reviewSchema>;

/** Cheap structural metrics that do not need a model. */
export function staticMetrics(code: string) {
  const lines = code.split('\n');
  const codeLines = lines.filter((l) => l.trim() && !/^\s*(\/\/|#|\/\*|\*)/.test(l));
  const commentLines = lines.filter((l) => /^\s*(\/\/|#|\/\*|\*)/.test(l));

  // Nesting depth from brace/indent structure — a rough complexity proxy.
  let depth = 0;
  let maxDepth = 0;
  for (const ch of code) {
    if (ch === '{' || ch === '(') depth++;
    else if (ch === '}' || ch === ')') depth = Math.max(0, depth - 1);
    maxDepth = Math.max(maxDepth, depth);
  }

  const loops = (code.match(/\b(for|while)\b/g) ?? []).length;
  const branches = (code.match(/\b(if|else if|elif|switch|case)\b/g) ?? []).length;
  const functions = (code.match(/\b(function|def|=>|public\s+static|private\s+)\b/g) ?? []).length;

  return {
    totalLines: lines.length,
    codeLines: codeLines.length,
    commentLines: commentLines.length,
    commentRatio: codeLines.length ? commentLines.length / codeLines.length : 0,
    maxNesting: maxDepth,
    loops,
    branches,
    functions,
    /** Rough cyclomatic complexity: one path plus each branch point. */
    cyclomatic: 1 + loops + branches,
  };
}

export class CodeAnalysisService {
  /** A nudge for a stuck candidate — never the answer. */
  static async hint(problem: string, code: string, language: string): Promise<string> {
    try {
      return await complete({
        model: FAST_MODEL,
        temperature: 0.5,
        maxTokens: 150,
        messages: [
          {
            role: 'system',
            content:
              'You give a single subtle hint to an interview candidate who is stuck. Never write code. Never state the algorithm by name. Point at what to reconsider in one or two sentences.',
          },
          {
            role: 'user',
            content: `Problem:\n${problem}\n\nLanguage: ${language}\nTheir code so far:\n${code.slice(0, 3000)}\n\nGive one hint.`,
          },
        ],
      });
    } catch {
      return 'Re-read the constraints and try walking through the sample input by hand.';
    }
  }

  static async review(args: {
    problem: string;
    code: string;
    language: string;
    execution: ExecutionResult;
    optimalTime?: string;
    optimalSpace?: string;
  }): Promise<CodeReview> {
    const metrics = staticMetrics(args.code);

    // Only failure shapes go to the model, never hidden expected outputs.
    const failureSummary = args.execution.cases
      .filter((c) => !c.passed)
      .slice(0, 4)
      .map((c) => `case ${c.index}: ${c.timedOut ? 'timed out' : c.stderr ? `errored (${c.stderr.slice(0, 120)})` : 'wrong output'}`)
      .join('; ');

    try {
      return await completeJson({
        schema: reviewSchema,
        model: SMART_MODEL,
        temperature: 0.2,
        maxTokens: 900,
        messages: [
          { role: 'system', content: 'You are a precise code reviewer. Output JSON only.' },
          {
            role: 'user',
            content: `Review this interview submission.

PROBLEM:
${args.problem}

LANGUAGE: ${args.language}

CODE:
${args.code.slice(0, 6000)}

TEST RESULTS: ${args.execution.passed}/${args.execution.total} passed.
${args.execution.compileError ? `COMPILE ERROR: ${args.execution.compileError.slice(0, 500)}` : ''}
${failureSummary ? `FAILURES: ${failureSummary}` : ''}

MEASURED STRUCTURE: ${metrics.codeLines} lines of code, ${metrics.loops} loops, ${metrics.branches} branches, max nesting ${metrics.maxNesting}, cyclomatic complexity ${metrics.cyclomatic}.
${args.optimalTime ? `OPTIMAL SOLUTION: ${args.optimalTime} time, ${args.optimalSpace} space.` : ''}

Judge the code as written. State the actual time and space complexity of THEIR algorithm, not the optimal one. Set matchesOptimal true only if their complexity matches the optimal. qualityScore and readability are 0 to 10. Be strict: code that fails its tests cannot score above 4 for quality.

Return JSON: { timeComplexity, spaceComplexity, qualityScore, readability, approach, feedback, improvements[], matchesOptimal }`,
          },
        ],
      });
    } catch (err) {
      console.error('[CodeAnalysis] review failed:', (err as Error).message);
      // Fall back to something derived rather than fabricated.
      const passRate = args.execution.total ? args.execution.passed / args.execution.total : 0;
      return {
        timeComplexity: metrics.loops >= 2 ? 'O(n^2) or worse' : metrics.loops === 1 ? 'O(n)' : 'O(1)',
        spaceComplexity: 'Unknown',
        qualityScore: Math.round(passRate * 6 + (metrics.maxNesting <= 4 ? 2 : 0)),
        readability: metrics.maxNesting <= 4 ? 6 : 4,
        approach: 'Automated review unavailable.',
        feedback: `${args.execution.passed} of ${args.execution.total} test cases passed. Detailed review could not be generated.`,
        improvements: [],
        matchesOptimal: false,
      };
    }
  }

  /**
   * Blends correctness, complexity and quality into one 0..10 coding score.
   * Correctness dominates: elegant code that fails its tests is still wrong.
   */
  static score(execution: ExecutionResult, review: CodeReview): { correctness: number; overall: number } {
    const correctness = execution.total ? (execution.passed / execution.total) * 10 : 0;
    const complexityBonus = review.matchesOptimal ? 10 : 5;
    const overall = correctness * 0.6 + review.qualityScore * 0.2 + complexityBonus * 0.1 + review.readability * 0.1;

    return {
      correctness: Math.round(correctness * 10) / 10,
      overall: Math.round(Math.max(0, Math.min(10, overall)) * 10) / 10,
    };
  }
}
