import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';
import { z } from 'zod';
import { AuthRequest } from '../lib/auth';
import { badRequest, forbidden, notFound, param } from '../lib/http';
import { prisma } from '../lib/prisma';
import { CodeAnalysisService } from '../services/CodeAnalysisService';
import { CodeExecutorService, TestCase } from '../services/CodeExecutorService';
import { EvaluationQueue } from '../services/EvaluationQueue';
import { EvaluationService } from '../services/EvaluationService';
import { InsightService } from '../services/InsightService';
import { MeetBotManager } from '../services/meetingBot/MeetBotManager';
import { TranscriptService } from '../services/TranscriptService';
import { evaluateJoinGate } from '../services/JoinGate';
import { ResumeService } from '../services/ResumeService';
import { VideoAnalysisService } from '../services/VideoAnalysisService';
import { PERSONALITIES } from '../services/personality';

/** Resolves the candidate-facing access token to the interview row. */
async function bySessionToken(token: string) {
  const sc = await prisma.sessionCandidate.findUnique({
    where: { accessToken: token },
    include: { candidate: true, interviewSession: true },
  });
  if (!sc) throw notFound('This interview link is not valid');
  return sc;
}

/**
 * Everything the interview room needs before the candidate joins. Deliberately
 * excludes the question list — the AI reveals questions one at a time.
 */
export const getInterviewContext = async (req: Request, res: Response) => {
  const sc = await bySessionToken(param(req, 'token'));
  const session = sc.interviewSession;
  const persona = PERSONALITIES[session.personality];

  const gate = evaluateJoinGate({
    scheduledAt: session.scheduledAt,
    sessionStatus: session.status,
    candidateStatus: sc.status,
    joinedAt: sc.joinedAt,
  });

  res.json({
    sessionCandidateId: sc.id,
    candidate: { name: sc.candidate.name, email: sc.candidate.email },
    status: sc.status,
    session: {
      title: session.title,
      type: session.type,
      experienceLevel: session.experienceLevel,
      durationMinutes: session.durationMinutes,
      scheduledAt: session.scheduledAt,
      language: session.language,
      codingEnabled: session.codingEnabled,
      videoAnalysisEnabled: session.videoAnalysisEnabled,
      skills: session.skills,
    },
    interviewer: { name: persona.name, style: persona.label },
    gate,
  });
};

export const getTranscript = async (req: Request, res: Response) => {
  const sc = await bySessionToken(param(req, 'token'));
  res.json(await TranscriptService.getTurns(sc.id));
};

// ---------------------------------------------------------------------------
// Coding
// ---------------------------------------------------------------------------

const runSchema = z.object({
  questionId: z.string().uuid().optional(),
  language: z.string().min(1),
  code: z.string().min(1, 'Write some code before submitting'),
  /** true = trial run against sample cases only; false = graded submission. */
  dryRun: z.boolean().default(false),
});

function testCasesFor(meta: unknown, includeHidden: boolean): TestCase[] {
  const cases = (meta as { testCases?: TestCase[] } | null)?.testCases ?? [];
  return includeHidden ? cases : cases.filter((c) => !c.hidden);
}

export const runCode = async (req: Request, res: Response) => {
  const sc = await bySessionToken(param(req, 'token'));
  const data = runSchema.parse(req.body);

  if (!sc.interviewSession.codingEnabled) throw forbidden('Coding is not enabled for this interview');

  const question = data.questionId
    ? await prisma.question.findUnique({ where: { id: data.questionId } })
    : null;

  const cases = testCasesFor(question?.meta, !data.dryRun);
  if (!cases.length && !data.dryRun) {
    throw badRequest('This problem has no test cases configured');
  }

  const execution = await CodeExecutorService.execute(data.language, data.code, cases);

  // A dry run is feedback for the candidate, not a graded attempt.
  if (data.dryRun) {
    return res.json({
      dryRun: true,
      passed: execution.passed,
      total: execution.total,
      compileError: execution.compileError,
      unsupported: execution.unsupported,
      cases: execution.cases.filter((c) => !c.hidden),
    });
  }

  const meta = (question?.meta ?? {}) as { optimalTime?: string; optimalSpace?: string; title?: string };

  const review = await CodeAnalysisService.review({
    problem: question?.content ?? 'Coding challenge',
    code: data.code,
    language: data.language,
    execution,
    optimalTime: meta.optimalTime,
    optimalSpace: meta.optimalSpace,
  });

  const scored = CodeAnalysisService.score(execution, review);

  const submission = await prisma.codingSubmission.create({
    data: {
      sessionCandidateId: sc.id,
      questionId: question?.id ?? null,
      language: data.language,
      code: data.code,
      passedCases: execution.passed,
      totalCases: execution.total,
      runtimeMs: execution.runtimeMs,
      // Hidden cases are recorded for the recruiter but never returned below.
      executionResult: {
        cases: execution.cases,
        compileError: execution.compileError ?? null,
        unsupported: execution.unsupported ?? null,
      } as unknown as Prisma.InputJsonValue,
      timeComplexity: review.timeComplexity,
      spaceComplexity: review.spaceComplexity,
      qualityScore: review.qualityScore,
      correctnessScore: scored.correctness,
      reviewFeedback: review.feedback,
    },
  });

  // An interview running inside a meeting has no socket from the candidate, so
  // this is how the submission reaches the interviewer waiting in the call. A
  // no-op for the built-in room, which reports over its own socket.
  await MeetBotManager.notifyCodingSubmitted(sc.id, {
    passed: execution.passed,
    total: execution.total,
  }).catch(() => {});

  res.json({
    submissionId: submission.id,
    passed: execution.passed,
    total: execution.total,
    compileError: execution.compileError,
    unsupported: execution.unsupported,
    // The candidate never sees hidden case contents.
    cases: execution.cases.filter((c) => !c.hidden),
    hiddenPassed: execution.cases.filter((c) => c.hidden && c.passed).length,
    hiddenTotal: execution.cases.filter((c) => c.hidden).length,
  });
};

/**
 * The coding exercise for a meeting interview.
 *
 * The built-in room receives its challenge over the interview socket. A
 * candidate in a Google Meet, Zoom or Teams call has no such socket — they open
 * a link — so the same content is served here instead.
 */
export const getCodingChallenge = async (req: Request, res: Response) => {
  const sc = await bySessionToken(param(req, 'token'));

  if (!sc.interviewSession.codingEnabled) throw forbidden('Coding is not enabled for this interview');

  const questions = await prisma.question.findMany({
    where: { questionSet: { interviewSessionId: sc.interviewSessionId }, category: 'CODING' },
    orderBy: { order: 'asc' },
  });

  if (!questions.length) throw notFound('No coding exercise has been set for this interview');

  const submitted = await prisma.codingSubmission.findMany({
    where: { sessionCandidateId: sc.id },
    select: { questionId: true },
  });
  const done = new Set(submitted.map((s) => s.questionId));

  // The first unanswered one is the one on the table; if all are answered, the
  // last is shown read-only so the candidate can see what they sent.
  const current = questions.find((q) => !done.has(q.id)) ?? questions[questions.length - 1]!;
  const meta = (current.meta ?? {}) as Record<string, unknown>;

  res.json({
    candidateName: sc.candidate.name,
    jobTitle: sc.interviewSession.title,
    alreadySubmitted: done.has(current.id),
    remaining: questions.filter((q) => !done.has(q.id)).length,
    question: {
      id: current.id,
      title: meta.title ?? 'Coding challenge',
      prompt: current.content,
      constraints: meta.constraints ?? [],
      starterCode: meta.starterCode ?? '',
      difficulty: current.difficulty,
      skill: current.skill,
      // Hidden test cases must never reach the browser.
      sampleTests: Array.isArray(meta.testCases)
        ? (meta.testCases as Array<{ input: string; output: string; hidden?: boolean }>).filter((t) => !t.hidden)
        : [],
    },
  });
};

export const getCodingHint = async (req: Request, res: Response) => {
  const sc = await bySessionToken(param(req, 'token'));
  const { questionId, code, language } = z
    .object({ questionId: z.string().uuid().optional(), code: z.string().default(''), language: z.string().default('javascript') })
    .parse(req.body);

  const question = questionId ? await prisma.question.findUnique({ where: { id: questionId } }) : null;

  const hint = await CodeAnalysisService.hint(question?.content ?? 'Coding challenge', code, language);

  await TranscriptService.logTurn(sc.id, { speaker: 'SYSTEM', text: `Hint requested: ${hint}`, round: 'CODING' });

  res.json({ hint });
};

// ---------------------------------------------------------------------------
// Video analysis
// ---------------------------------------------------------------------------

const frameSchema = z.object({
  facePresence: z.number().min(0).max(1),
  motion: z.number().min(0).max(1),
  gazeStability: z.number().min(0).max(1),
  expression: z.string().nullish(),
});

export const postVideoMetrics = async (req: Request, res: Response) => {
  const sc = await bySessionToken(param(req, 'token'));
  if (!sc.interviewSession.videoAnalysisEnabled) return res.json({ recorded: 0 });

  const body = z.object({ frames: z.array(frameSchema).min(1).max(120) }).parse(req.body);

  const recorded = await VideoAnalysisService.recordBatch(
    sc.id,
    body.frames.map((f) => ({ ...f, expression: f.expression ?? null })),
  );

  res.json({ recorded });
};

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

/** Candidate-facing upload, from the pre-interview screen. */
export const uploadResume = async (req: Request, res: Response) => {
  const sc = await bySessionToken(param(req, 'token'));
  const file = (req as unknown as { file?: Express.Multer.File }).file;
  if (!file) throw badRequest('No resume was uploaded');

  if (['COMPLETED', 'ABSENT', 'CANCELLED'].includes(sc.status)) {
    throw forbidden('This interview is already closed');
  }

  const result = await ResumeService.attach({
    sessionCandidateId: sc.id,
    buffer: file.buffer,
    fileName: file.originalname,
    mimeType: file.mimetype,
  });

  res.status(201).json({
    fileName: file.originalname,
    characters: result.characters,
    pages: result.pages,
    skills: result.profile?.skills ?? [],
    yearsExperience: result.profile?.totalYearsExperience ?? 0,
    tailoredQuestions: result.questions.length,
    // The file is safely stored even when the AI could not read it yet.
    analysed: result.analysed,
    analysisPending: !result.analysed,
  });
};

/** What the candidate sees about their own uploaded resume. */
export const getResumeStatus = async (req: Request, res: Response) => {
  const sc = await bySessionToken(param(req, 'token'));

  res.json({
    uploaded: Boolean(sc.resumeParsedAt),
    fileName: sc.resumeFileName,
    parsedAt: sc.resumeParsedAt,
  });
};

/** Full parsed profile, for the recruiter reviewing a candidate. */
export const getCandidateResume = async (req: AuthRequest, res: Response) => {
  const sc = await prisma.sessionCandidate.findFirst({
    where: { id: param(req, 'sessionCandidateId'), interviewSession: { userId: req.user!.userId } },
    select: {
      resumeFileName: true,
      resumeMimeType: true,
      resumeSizeBytes: true,
      resumeText: true,
      resumeProfile: true,
      resumeQuestions: true,
      resumeParsedAt: true,
      candidate: { select: { name: true } },
    },
  });
  if (!sc) throw notFound('Interview not found');
  if (!sc.resumeParsedAt) throw notFound('This candidate has not uploaded a resume');

  res.json(sc);
};

/** Serves the original resume file straight out of Postgres. */
export const downloadResume = async (req: AuthRequest, res: Response) => {
  const sc = await prisma.sessionCandidate.findFirst({
    where: { id: param(req, 'sessionCandidateId'), interviewSession: { userId: req.user!.userId } },
    select: {
      resumeFile: true,
      resumeFileName: true,
      resumeMimeType: true,
      candidate: { select: { name: true } },
    },
  });

  if (!sc?.resumeFile) throw notFound('No resume has been uploaded for this candidate');

  const safeName = (sc.resumeFileName ?? `${sc.candidate.name}-resume`).replace(/[^a-zA-Z0-9._-]/g, '_');

  res.setHeader('Content-Type', sc.resumeMimeType ?? 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
  res.send(Buffer.from(sc.resumeFile));
};

/** Recruiter-side upload, for when the resume arrives out of band. */
export const uploadResumeForCandidate = async (req: AuthRequest, res: Response) => {
  const sc = await prisma.sessionCandidate.findFirst({
    where: { id: param(req, 'sessionCandidateId'), interviewSession: { userId: req.user!.userId } },
    select: { id: true },
  });
  if (!sc) throw notFound('Interview not found');

  const file = (req as unknown as { file?: Express.Multer.File }).file;
  if (!file) throw badRequest('No resume was uploaded');

  const result = await ResumeService.attach({
    sessionCandidateId: sc.id,
    buffer: file.buffer,
    fileName: file.originalname,
    mimeType: file.mimetype,
  });

  res.status(201).json({
    fileName: file.originalname,
    profile: result.profile,
    tailoredQuestions: result.questions.length,
  });
};

// ---------------------------------------------------------------------------
// Insights & evaluation
// ---------------------------------------------------------------------------

export const getLiveInsights = async (req: AuthRequest, res: Response) => {
  const sc = await prisma.sessionCandidate.findFirst({
    where: { id: param(req, 'sessionCandidateId'), interviewSession: { userId: req.user!.userId } },
    select: { id: true },
  });
  if (!sc) throw notFound('Interview not found');

  const [insights, summary, video] = await Promise.all([
    InsightService.list(sc.id),
    InsightService.summarise(sc.id),
    VideoAnalysisService.summarise(sc.id),
  ]);

  res.json({ insights, summary, video });
};

/**
 * Forces evaluation now, clearing any previous failure state. Safe to call more
 * than once — it replaces the existing report.
 */
export const evaluateInterview = async (req: AuthRequest, res: Response) => {
  const sc = await prisma.sessionCandidate.findFirst({
    where: { id: param(req, 'sessionCandidateId'), interviewSession: { userId: req.user!.userId } },
    select: { id: true },
  });
  if (!sc) throw notFound('Interview not found');

  // Clear the backoff first, so a manual retry is never blocked by a previous
  // failure that has already exhausted its automatic attempts.
  await EvaluationQueue.reset(sc.id);

  res.json(await EvaluationService.evaluate(sc.id));
};

/** Whether a report is ready, still being retried, or has given up. */
export const getEvaluationStatus = async (req: AuthRequest, res: Response) => {
  const sc = await prisma.sessionCandidate.findFirst({
    where: { id: param(req, 'sessionCandidateId'), interviewSession: { userId: req.user!.userId } },
    select: {
      status: true,
      completedAt: true,
      evaluationAttempts: true,
      evaluationError: true,
      evaluationRetryAt: true,
      report: { select: { id: true } },
      transcript: { select: { id: true } },
    },
  });
  if (!sc) throw notFound('Interview not found');

  const state = sc.report
    ? 'READY'
    : sc.status !== 'COMPLETED'
      ? 'NOT_INTERVIEWED'
      : !sc.transcript
        ? 'NO_TRANSCRIPT'
        : sc.evaluationRetryAt
          ? 'RETRYING'
          : sc.evaluationAttempts > 0
            ? 'FAILED'
            : 'PENDING';

  res.json({
    state,
    reportId: sc.report?.id ?? null,
    attempts: sc.evaluationAttempts,
    error: sc.evaluationError,
    nextRetryAt: sc.evaluationRetryAt,
  });
};
