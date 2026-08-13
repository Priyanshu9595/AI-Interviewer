import { InterviewType, InterviewerPersonality, Prisma, QuestionCategory, QuestionDifficulty } from '@prisma/client';
import { z } from 'zod';
import { completeJson, SMART_MODEL } from '../lib/ai';
import { env } from '../lib/env';
import { prisma } from '../lib/prisma';
import { LANGUAGES } from './personality';

const difficulty = z.enum(['EASY', 'MEDIUM', 'HARD']);

const introQuestion = z.object({ text: z.string(), purpose: z.string().default('warm-up') });

const hrQuestion = z.object({
  text: z.string(),
  competency: z.string().default('general'),
  difficulty: difficulty.default('MEDIUM'),
  expectedPoints: z.array(z.string()).default([]),
  redFlags: z.array(z.string()).default([]),
});

const technicalQuestion = z.object({
  text: z.string(),
  skill: z.string(),
  difficulty: difficulty.default('MEDIUM'),
  expectedAnswer: z.string(),
});

const scenarioQuestion = z.object({
  text: z.string(),
  skill: z.string(),
  difficulty: difficulty.default('MEDIUM'),
  expectedApproach: z.string(),
  followUp: z.string().default(''),
});

const projectQuestion = z.object({
  text: z.string(),
  focusArea: z.string().default('project depth'),
  expectedPoints: z.array(z.string()).default([]),
});

const codingQuestion = z.object({
  title: z.string(),
  text: z.string(),
  skill: z.string(),
  difficulty: difficulty.default('MEDIUM'),
  constraints: z.array(z.string()).default([]),
  optimalTime: z.string().default('O(n)'),
  optimalSpace: z.string().default('O(1)'),
  starterCode: z.string().default(''),
  testCases: z
    .array(z.object({ input: z.string(), output: z.string(), hidden: z.boolean().default(false) }))
    .default([]),
});

const questionSetSchema = z.object({
  intro: z.array(introQuestion).default([]),
  hr: z.array(hrQuestion).default([]),
  technical: z.array(technicalQuestion).default([]),
  scenario: z.array(scenarioQuestion).default([]),
  project: z.array(projectQuestion).default([]),
  coding: z.array(codingQuestion).default([]),
});

export type GeneratedQuestionSet = z.infer<typeof questionSetSchema>;

export interface GenerationInput {
  title: string;
  jobDescription: string;
  skills: string[];
  experienceLevel: string;
  type: InterviewType;
  durationMinutes: number;
  language?: string;
  personality?: InterviewerPersonality;
  codingEnabled?: boolean;
}

/**
 * Decides how many questions of each kind fit the interview.
 *
 * Coding is included whenever the recruiter enabled it and the round is not
 * HR-only. It is never dropped for being "too short" — silently ignoring an
 * explicitly enabled feature is worse than a tight schedule. Short interviews
 * instead get a smaller coding budget and fewer conversational questions.
 */
function planQuestionMix(type: InterviewType, durationMinutes: number, codingEnabled: boolean) {
  const wantsCoding = codingEnabled && type !== 'HR';

  // A coding task needs roughly 10 minutes, but never more than half the round.
  const codingMinutes = wantsCoding ? Math.min(10, Math.max(6, Math.round(durationMinutes * 0.45))) : 0;
  const codingCount = wantsCoding ? 1 : 0;

  const conversationalMinutes = durationMinutes - codingMinutes - 3; // 3 min for intro + closing
  const slots = Math.max(wantsCoding ? 2 : 3, Math.floor(conversationalMinutes / 2.5));

  if (type === 'HR') {
    return { intro: 1, hr: Math.max(3, slots - 2), technical: 0, scenario: 1, project: 1, coding: 0 };
  }

  if (type === 'TECHNICAL') {
    return {
      intro: 1,
      hr: 0,
      technical: Math.max(wantsCoding ? 1 : 3, Math.round(slots * 0.55)),
      scenario: Math.max(wantsCoding ? 0 : 1, Math.round(slots * 0.2)),
      project: Math.max(wantsCoding ? 0 : 1, Math.round(slots * 0.2)),
      coding: codingCount,
    };
  }

  // MIXED
  return {
    intro: 1,
    hr: Math.max(wantsCoding ? 1 : 2, Math.round(slots * 0.3)),
    technical: Math.max(wantsCoding ? 1 : 2, Math.round(slots * 0.35)),
    scenario: Math.max(wantsCoding ? 0 : 1, Math.round(slots * 0.15)),
    project: Math.max(wantsCoding ? 0 : 1, Math.round(slots * 0.15)),
    coding: codingCount,
  };
}

/** Deterministic fallback so an LLM outage never leaves a session unusable. */
function fallbackSet(input: GenerationInput, mix: ReturnType<typeof planQuestionMix>): GeneratedQuestionSet {
  const skills = input.skills.length ? input.skills : ['problem solving'];
  const pick = (i: number) => skills[i % skills.length] as string;

  return {
    intro: [{ text: 'To start, could you walk me through your background and what you are working on right now?', purpose: 'warm-up' }],
    hr: Array.from({ length: mix.hr }, (_, i) => ({
      text: [
        'Tell me about a time you disagreed with a teammate. How did you resolve it?',
        'Describe a project where the requirements changed midway. What did you do?',
        'What kind of work environment brings out your best?',
        'Tell me about something you taught yourself recently and why.',
        'Describe a moment you took ownership of something outside your job description.',
      ][i % 5] as string,
      competency: ['teamwork', 'adaptability', 'culture fit', 'learning mindset', 'ownership'][i % 5] as string,
      difficulty: 'MEDIUM' as const,
      expectedPoints: ['specific situation', 'their own actions', 'measurable outcome'],
      redFlags: ['blames others', 'no concrete example'],
    })),
    technical: Array.from({ length: mix.technical }, (_, i) => ({
      text: `Walk me through how you would use ${pick(i)} to solve a real problem you have faced. What trade-offs did you weigh?`,
      skill: pick(i),
      difficulty: 'MEDIUM' as const,
      expectedAnswer: `Concrete, first-hand use of ${pick(i)} with reasoning about alternatives and trade-offs.`,
    })),
    scenario: Array.from({ length: mix.scenario }, (_, i) => ({
      text: `Your production system starts failing intermittently right after a ${pick(i)} change ships. Talk me through your first hour.`,
      skill: pick(i),
      difficulty: 'MEDIUM' as const,
      expectedApproach: 'Stabilise first, gather evidence, form a hypothesis, verify, then fix and follow up.',
      followUp: 'What would you change so it cannot happen again?',
    })),
    project: Array.from({ length: mix.project }, () => ({
      text: 'Pick the project you are proudest of. What was your specific contribution, and what would you do differently now?',
      focusArea: 'project depth',
      expectedPoints: ['clear personal ownership', 'technical detail', 'honest hindsight'],
    })),
    coding: Array.from({ length: mix.coding }, () => ({
      title: 'Two Sum',
      text: 'Given a list of integers and a target, return the indices of the two numbers that add up to the target. Read the array on the first line as space-separated integers and the target on the second line. Print the two indices separated by a space.',
      skill: 'algorithms',
      difficulty: 'EASY' as const,
      constraints: ['2 <= n <= 10000', 'Exactly one valid answer exists'],
      optimalTime: 'O(n)',
      optimalSpace: 'O(n)',
      starterCode: '',
      testCases: [
        { input: '2 7 11 15\n9', output: '0 1', hidden: false },
        { input: '3 2 4\n6', output: '1 2', hidden: false },
        { input: '3 3\n6', output: '0 1', hidden: true },
      ],
    })),
  };
}

export class QuestionGenerationService {
  static async generate(input: GenerationInput): Promise<GeneratedQuestionSet> {
    const mix = planQuestionMix(input.type, input.durationMinutes, input.codingEnabled ?? true);
    const languageName = LANGUAGES[input.language ?? 'en-US'] ?? 'English';

    const prompt = `You design interview question sets for a voice-based AI interviewer.

ROLE: ${input.title}
JOB DESCRIPTION: ${input.jobDescription}
REQUIRED SKILLS: ${input.skills.join(', ')}
EXPERIENCE LEVEL: ${input.experienceLevel}
INTERVIEW TYPE: ${input.type}
DURATION: ${input.durationMinutes} minutes
LANGUAGE: write every question in ${languageName}. Keep technical terms in English.

Produce exactly this many questions:
- intro: ${mix.intro}
- hr: ${mix.hr}
- technical: ${mix.technical}
- scenario: ${mix.scenario}
- project: ${mix.project}
- coding: ${mix.coding}

RULES
- These questions are asked mid-conversation by an interviewer who has ALREADY
  greeted the candidate and introduced herself. Never open a question with a
  greeting, a self-introduction, or interview preamble ("Hello, my name is...",
  "today we will...", "welcome"). Each "text" is the question alone.
- Every technical question must map to a skill named in the job description or the skills list.
- Calibrate difficulty to "${input.experienceLevel}". Freshers get no system design. Senior candidates get no syntax trivia.
- No question answerable in a single word. No two questions may test the same thing.
- Write them the way a person says them out loud, not the way they are typed. No markdown, bullets or symbols in "text".
- Ground scenario and project questions in the actual domain of the job description.
- This set is shared by every candidate in the session, so keep it about the role.
  Resume-specific questions are generated per candidate elsewhere.
${
  mix.coding
    ? `
CODING PROBLEM RULES (these are strict — a broken problem wastes the interview)
- It is judged by running the program and comparing stdout. There is no function
  harness and no return value. NEVER write "write a function that takes X and
  returns Y" or mention parameters, signatures or return values.
- Phrase it as: read <this> from standard input, print <that> to standard output.
- State the exact input format line by line, and the exact output format, inside "text".
- Solvable in under 10 minutes by a ${input.experienceLevel} candidate.
- Provide 4 to 6 test cases. "input" is the literal stdin (use \\n between lines)
  and "output" is the literal expected stdout, with no extra prose.
- Mark at least 2 of them "hidden": true. Hidden cases are graded but never shown
  to the candidate, so they cannot hard-code the visible answers.
- Every test case must be genuinely correct. Work the answer out before writing it.
- Do not use linked lists, trees or any structure that cannot be expressed as
  plain lines of text on stdin.`
    : ''
}

Return JSON with keys intro, hr, technical, scenario, project, coding. Each is an array of objects:
intro: { text, purpose }
hr: { text, competency, difficulty, expectedPoints[], redFlags[] }
technical: { text, skill, difficulty, expectedAnswer }
scenario: { text, skill, difficulty, expectedApproach, followUp }
project: { text, focusArea, expectedPoints[] }
coding: { title, text, skill, difficulty, constraints[], optimalTime, optimalSpace, starterCode, testCases[{input, output, hidden}] }
difficulty is one of EASY, MEDIUM, HARD.`;

    let generated: GeneratedQuestionSet;
    try {
      generated = await completeJson({
        schema: questionSetSchema,
        model: SMART_MODEL,
        temperature: 0.7,
        maxTokens: 6000,
        messages: [
          { role: 'system', content: 'You output only valid JSON. Never use markdown fences.' },
          { role: 'user', content: prompt },
        ],
      });
    } catch (err) {
      console.error('[QuestionGeneration] falling back to template set:', (err as Error).message);
      return fallbackSet(input, mix);
    }

    if (mix.coding > 0) {
      generated.coding = this.repairCodingQuestions(generated.coding, input, mix);
    }

    return generated;
  }

  /**
   * Coding problems are the easiest thing for a model to get subtly wrong, and a
   * broken one burns ten minutes of a real interview. Anything unusable is
   * replaced with the known-good template rather than shipped.
   */
  private static repairCodingQuestions(
    questions: GeneratedQuestionSet['coding'],
    input: GenerationInput,
    mix: ReturnType<typeof planQuestionMix>,
  ): GeneratedQuestionSet['coding'] {
    // Phrasing that contradicts how submissions are actually judged (stdin/stdout).
    const functionStyle = /\b(write a function|the function should|takes? (the )?(head|root|an? (array|list|string|integer))\b.*\breturns?\b|return (the|a|an) )/i;
    // Structures that cannot be expressed as lines of text on stdin.
    const unsupportedShape = /\b(linked list|binary tree|tree node|listnode|treenode|graph node)\b/i;

    const repaired = questions.filter((q) => {
      const runnable = q.testCases.filter((t) => t.input?.trim() && t.output?.trim());

      if (runnable.length < 2) {
        console.warn(`[QuestionGeneration] dropped "${q.title}": only ${runnable.length} runnable test case(s)`);
        return false;
      }
      if (functionStyle.test(q.text)) {
        console.warn(`[QuestionGeneration] dropped "${q.title}": phrased as a function, but grading is stdin/stdout`);
        return false;
      }
      if (unsupportedShape.test(q.text) || unsupportedShape.test(q.title)) {
        console.warn(`[QuestionGeneration] dropped "${q.title}": uses a structure that cannot come from stdin`);
        return false;
      }

      q.testCases = runnable;

      // Grading needs cases the candidate cannot see, otherwise the visible
      // answers can simply be hard-coded.
      if (!q.testCases.some((t) => t.hidden)) {
        const keepVisible = Math.max(1, Math.ceil(q.testCases.length / 2));
        q.testCases = q.testCases.map((t, i) => ({ ...t, hidden: i >= keepVisible }));
      }

      return true;
    });

    if (repaired.length >= mix.coding) return repaired.slice(0, mix.coding);

    console.warn(
      `[QuestionGeneration] only ${repaired.length}/${mix.coding} usable coding question(s); filling from the template set.`,
    );
    return [...repaired, ...fallbackSet(input, mix).coding].slice(0, mix.coding);
  }

  /** Replaces any existing set for the session and returns the new set id. */
  static async save(interviewSessionId: string, data: GeneratedQuestionSet): Promise<string> {
    await prisma.questionSet.deleteMany({ where: { interviewSessionId } });

    const set = await prisma.questionSet.create({
      data: { interviewSessionId, generatedBy: SMART_MODEL },
    });

    let order = 0;
    const rows: Prisma.QuestionCreateManyInput[] = [];

    const push = (
      category: QuestionCategory,
      content: string,
      opts: {
        skill?: string | null;
        difficulty?: QuestionDifficulty;
        expectedAnswer?: string;
        meta?: Prisma.InputJsonValue;
      } = {},
    ) => {
      rows.push({
        questionSetId: set.id,
        content,
        order: order++,
        category,
        difficulty: opts.difficulty ?? 'MEDIUM',
        skill: opts.skill ?? null,
        expectedAnswer: opts.expectedAnswer ?? null,
        meta: opts.meta,
      });
    };

    data.intro.forEach((q) => push('INTRO', q.text, { meta: { purpose: q.purpose } }));

    data.hr.forEach((q) =>
      push('HR', q.text, {
        skill: q.competency,
        difficulty: q.difficulty,
        expectedAnswer: q.expectedPoints.join('; '),
        meta: { expectedPoints: q.expectedPoints, redFlags: q.redFlags },
      }),
    );

    data.technical.forEach((q) =>
      push('TECHNICAL', q.text, { skill: q.skill, difficulty: q.difficulty, expectedAnswer: q.expectedAnswer }),
    );

    data.scenario.forEach((q) =>
      push('SCENARIO', q.text, {
        skill: q.skill,
        difficulty: q.difficulty,
        expectedAnswer: q.expectedApproach,
        meta: { followUp: q.followUp },
      }),
    );

    data.project.forEach((q) =>
      push('PROJECT', q.text, {
        skill: q.focusArea,
        expectedAnswer: q.expectedPoints.join('; '),
        meta: { expectedPoints: q.expectedPoints },
      }),
    );

    data.coding.forEach((q) =>
      push('CODING', q.text, {
        skill: q.skill,
        difficulty: q.difficulty,
        expectedAnswer: `Optimal: ${q.optimalTime} time, ${q.optimalSpace} space.`,
        meta: {
          title: q.title,
          constraints: q.constraints,
          optimalTime: q.optimalTime,
          optimalSpace: q.optimalSpace,
          starterCode: q.starterCode,
          testCases: q.testCases,
        },
      }),
    );

    if (rows.length) await prisma.question.createMany({ data: rows });
    return set.id;
  }

  /** Generates and persists in one step. */
  static async generateAndSave(sessionId: string): Promise<string> {
    const session = await prisma.interviewSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new Error('Session not found');

    const generated = await this.generate({
      title: session.title,
      jobDescription: session.jobDescription,
      skills: session.skills,
      experienceLevel: session.experienceLevel,
      type: session.type,
      durationMinutes: session.durationMinutes,
      language: session.language,
      personality: session.personality,
      codingEnabled: session.codingEnabled,
    });

    return this.save(sessionId, generated);
  }
}
