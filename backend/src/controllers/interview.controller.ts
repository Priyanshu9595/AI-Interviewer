import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import { AuthRequest } from '../lib/auth';
import { badRequest, forbidden, notFound, param } from '../lib/http';
import { prisma } from '../lib/prisma';
import { CodeAnalysisService } from '../services/CodeAnalysisService';
import { CodeExecutorService, TestCase } from '../services/CodeExecutorService';
import { EvaluationQueue } from '../services/EvaluationQueue';
import { EvaluationService } from '../services/EvaluationService';
import { InsightService } from '../services/InsightService';
import { TranscriptService } from '../services/TranscriptService';
import { createReadStream } from 'fs';
import { env } from '../lib/env';
import { signPlaybackToken, verifyPlaybackToken } from '../lib/playbackToken';
import { evaluateJoinGate } from '../services/JoinGate';
import { RecordingService } from '../services/RecordingService';
import { ResumeService } from '../services/ResumeService';
import { VideoAnalysisService } from '../services/VideoAnalysisService';
import { PERSONALITIES } from '../services/personality';
import { UPLOAD_DIR, deleteAsset, storeAsset } from '../lib/storage';

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
      recordingEnabled: session.recordingEnabled,
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
// Recording
// ---------------------------------------------------------------------------

/**
 * Receives one chunk of the in-progress recording.
 *
 * Called every few seconds while the interview runs so that an abrupt exit
 * cannot lose the whole session. Kept deliberately cheap: append and return.
 */
export const uploadRecordingChunk = async (req: Request, res: Response) => {
  const sc = await bySessionToken(param(req, 'token'));
  if (!sc.interviewSession.recordingEnabled) throw forbidden('Recording is disabled for this interview');

  const file = (req as unknown as { file?: Express.Multer.File }).file;
  if (!file?.buffer?.length) throw badRequest('Empty chunk');

  const bytes = await RecordingService.appendChunk(sc.id, file.buffer);
  res.json({ bytes });
};

/**
 * Assembles the streamed chunks into the stored recording.
 *
 * Also called server-side when an interview ends, so a candidate who closes the
 * tab still gets whatever was captured up to that point.
 */
export const finaliseRecording = async (req: Request, res: Response) => {
  const sc = await bySessionToken(param(req, 'token'));
  const durationSeconds = parseInt(String(req.body?.durationSeconds ?? '0'), 10) || 0;

  const result = await RecordingService.finalise(sc.id, {
    mimeType: String(req.body?.mimeType ?? 'video/webm'),
    durationSeconds,
  });

  res.json(result);
};

/**
 * Legacy whole-file upload, kept as a fallback for a client that could not
 * stream (for example a browser whose MediaRecorder produced a single blob).
 */
export const uploadRecording = async (req: Request, res: Response) => {
  const sc = await bySessionToken(param(req, 'token'));
  const file = (req as unknown as { file?: Express.Multer.File }).file;
  if (!file) throw badRequest('No recording was uploaded');

  if (!sc.interviewSession.recordingEnabled) throw forbidden('Recording is disabled for this interview');

  const clientDuration = parseInt(String(req.body?.durationSeconds ?? '0'), 10) || 0;

  // Replacing an existing recording must not orphan the previous asset.
  const previous = await prisma.recording.findUnique({ where: { sessionCandidateId: sc.id } });
  if (previous) await deleteAsset(previous);

  const asset = await storeAsset({
    buffer: file.buffer,
    fileName: file.originalname || 'interview.webm',
    folder: 'ai-interview/recordings',
    publicId: sc.id,
    resourceType: 'video',
  });

  const data = {
    url: asset.url,
    publicId: asset.publicId,
    storage: asset.storage,
    filePath: asset.filePath,
    mimeType: file.mimetype,
    sizeBytes: asset.bytes,
    // Cloudinary probes the real duration; trust it over the client's estimate.
    durationSeconds: asset.durationSeconds || clientDuration,
  };

  const recording = await prisma.recording.upsert({
    where: { sessionCandidateId: sc.id },
    create: { sessionCandidateId: sc.id, ...data },
    update: data,
  });

  // Chunks are now redundant.
  await RecordingService.discard(sc.id);

  res.status(201).json({
    id: recording.id,
    storage: recording.storage,
    sizeBytes: recording.sizeBytes,
    durationSeconds: recording.durationSeconds,
  });
};

/**
 * Returns a playable URL for a recording, plus its metadata.
 *
 * A `<video>` element cannot attach an Authorization header, so the protected
 * endpoint hands back a URL instead of the bytes: the Cloudinary URL directly,
 * or a short-lived signed route for locally stored files.
 */
export const getRecording = async (req: AuthRequest, res: Response) => {
  const sessionCandidateId = param(req, 'sessionCandidateId');

  const recording = await prisma.recording.findFirst({
    where: {
      sessionCandidateId,
      sessionCandidate: { interviewSession: { userId: req.user!.userId } },
    },
    include: {
      sessionCandidate: {
        select: {
          completedAt: true,
          candidate: { select: { name: true } },
          interviewSession: { select: { title: true } },
        },
      },
    },
  });

  if (!recording) throw notFound('No recording available for this interview');

  const url =
    recording.storage === 'CLOUDINARY' && recording.url
      ? recording.url.replace(/\.webm$/i, '.mp4')
      : `${env.API_URL}/api/recordings/${signPlaybackToken(recording.id)}`;

  res.json({
    url,
    storage: recording.storage,
    mimeType: recording.mimeType,
    sizeBytes: recording.sizeBytes,
    durationSeconds: recording.durationSeconds,
    recordedAt: recording.createdAt,
    candidateName: recording.sessionCandidate.candidate.name,
    sessionTitle: recording.sessionCandidate.interviewSession.title,
  });
};

/**
 * Streams a locally stored recording to anyone holding a valid playback token.
 *
 * Deliberately outside the bearer-token middleware: the token in the path is
 * the credential, because media elements cannot send headers. Supports HTTP
 * range requests so the player can seek instead of buffering the whole file.
 */
export const streamRecording = async (req: Request, res: Response) => {
  const recordingId = verifyPlaybackToken(param(req, 'playbackToken'));
  if (!recordingId) throw forbidden('This playback link is invalid or has expired');

  const recording = await prisma.recording.findUnique({ where: { id: recordingId } });
  if (!recording) throw notFound('Recording not found');

  if (recording.storage === 'CLOUDINARY' && recording.url) return res.redirect(recording.url.replace(/\.webm$/i, '.mp4'));
  if (!recording.filePath) throw notFound('This recording has no stored file');

  // Reject any path that escapes the uploads directory.
  const absolute = path.resolve(UPLOAD_DIR, recording.filePath);
  if (!absolute.startsWith(UPLOAD_DIR)) throw forbidden('Invalid recording path');

  let stat;
  try {
    stat = await fs.stat(absolute);
  } catch {
    throw notFound('The recording file is missing from disk');
  }

  res.setHeader('Content-Type', recording.mimeType);
  res.setHeader('Accept-Ranges', 'bytes');

  const range = req.headers.range;

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    const start = match?.[1] ? parseInt(match[1], 10) : 0;
    const end = match?.[2] ? parseInt(match[2], 10) : stat.size - 1;

    if (start >= stat.size || end >= stat.size || start > end) {
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      return res.status(416).end();
    }

    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', end - start + 1);
    return createReadStream(absolute, { start, end }).pipe(res);
  }

  res.setHeader('Content-Length', stat.size);
  return createReadStream(absolute).pipe(res);
};

/** Every recording the recruiter owns, newest first. */
export const listRecordings = async (req: AuthRequest, res: Response) => {
  const rows = await prisma.recording.findMany({
    where: { sessionCandidate: { interviewSession: { userId: req.user!.userId } } },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      sessionCandidate: {
        select: {
          id: true,
          status: true,
          completedAt: true,
          candidate: { select: { name: true, email: true } },
          interviewSession: { select: { id: true, title: true } },
          report: { select: { id: true, overallRating: true, hiringRecommendation: true } },
        },
      },
    },
  });

  res.json(
    rows.map((r) => ({
      id: r.id,
      sessionCandidateId: r.sessionCandidateId,
      storage: r.storage,
      mimeType: r.mimeType,
      sizeBytes: r.sizeBytes,
      durationSeconds: r.durationSeconds,
      recordedAt: r.createdAt,
      candidate: r.sessionCandidate.candidate,
      session: r.sessionCandidate.interviewSession,
      report: r.sessionCandidate.report,
    })),
  );
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
