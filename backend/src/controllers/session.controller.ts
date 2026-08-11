import { Response } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuthRequest } from '../lib/auth';
import { badRequest, notFound, param } from '../lib/http';
import { prisma } from '../lib/prisma';
import { availableProviders, createMeeting, MeetingCreationError, MeetingProviderName } from '../lib/providers';
import { QuestionGenerationService } from '../services/QuestionGenerationService';
import { RankingService } from '../services/RankingService';
import { SchedulerService } from '../services/SchedulerService';
import { listLanguages, listPersonalities } from '../services/personality';

const createSchema = z.object({
  title: z.string().min(2, 'Give the session a title'),
  jobDescription: z.string().min(30, 'The job description needs at least 30 characters to generate good questions'),
  skills: z.array(z.string().min(1)).min(1, 'List at least one required skill'),
  experienceLevel: z.string().min(1),
  type: z.enum(['TECHNICAL', 'HR', 'MIXED']),
  scheduledAt: z.string().datetime({ offset: true }).or(z.string().min(1)),
  durationMinutes: z.number().int().min(10).max(180),
  // No default and no built-in room: an interview is a real meeting somewhere
  // the AI interviewer can join, so the caller has to say where.
  meetingProvider: z.enum(['GOOGLE_MEET', 'ZOOM', 'MS_TEAMS']),
  personality: z.enum(['FRIENDLY', 'NEUTRAL', 'FORMAL', 'CHALLENGING']).default('FRIENDLY'),
  language: z.string().default('en-US'),
  codingEnabled: z.boolean().default(true),
  videoAnalysisEnabled: z.boolean().default(true),
  recordingEnabled: z.boolean().default(true),
  passMark: z.number().int().min(1).max(10).default(6),
  /** Generate the question set immediately rather than on first join. */
  generateQuestions: z.boolean().default(true),
});

export const getConfigOptions = async (_req: AuthRequest, res: Response) => {
  res.json({
    providers: availableProviders(),
    personalities: listPersonalities(),
    languages: listLanguages(),
    experienceLevels: [
      'Fresher (0-1 years)',
      'Junior (1-3 years)',
      'Mid-level (3-5 years)',
      'Senior (5-8 years)',
      'Lead (8+ years)',
    ],
  });
};

export const createSession = async (req: AuthRequest, res: Response) => {
  const data = createSchema.parse(req.body);

  const scheduledAt = new Date(data.scheduledAt);
  if (Number.isNaN(scheduledAt.getTime())) throw badRequest('scheduledAt is not a valid date');

  // A provider that cannot produce a meeting is the recruiter's problem to fix,
  // not a server fault — say so with a 400 they can act on.
  const meeting = await createMeeting(
    data.meetingProvider as MeetingProviderName,
    data.title,
    scheduledAt,
    data.durationMinutes,
  ).catch((err) => {
    if (err instanceof MeetingCreationError) throw badRequest(err.message);
    throw err;
  });

  const session = await prisma.interviewSession.create({
    data: {
      userId: req.user!.userId,
      title: data.title,
      jobDescription: data.jobDescription,
      skills: data.skills,
      experienceLevel: data.experienceLevel,
      type: data.type,
      scheduledAt,
      durationMinutes: data.durationMinutes,
      status: 'SCHEDULED',
      meetingProvider: meeting.provider,
      meetingLink: meeting.link,
      externalEventId: meeting.externalEventId ?? null,
      personality: data.personality,
      language: data.language,
      codingEnabled: data.codingEnabled,
      videoAnalysisEnabled: data.videoAnalysisEnabled,
      recordingEnabled: data.recordingEnabled,
      passMark: data.passMark,
    },
  });

  // Question generation takes several seconds; do not make the recruiter wait.
  if (data.generateQuestions) {
    void QuestionGenerationService.generateAndSave(session.id).catch((err) =>
      console.error(`[session] question generation failed for ${session.id}:`, err.message),
    );
  }

  res.status(201).json(session);
};

export const listSessions = async (req: AuthRequest, res: Response) => {
  const { search, status, type, dateStart, dateEnd, page = '1', limit = '10' } = req.query as Record<string, string>;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));

  const where: Prisma.InterviewSessionWhereInput = { userId: req.user!.userId };

  if (search) {
    where.OR = [
      { title: { contains: search, mode: 'insensitive' } },
      { jobDescription: { contains: search, mode: 'insensitive' } },
    ];
  }
  if (status) where.status = status as Prisma.InterviewSessionWhereInput['status'];
  if (type) where.type = type as Prisma.InterviewSessionWhereInput['type'];
  if (dateStart || dateEnd) {
    where.scheduledAt = {};
    if (dateStart) where.scheduledAt.gte = new Date(dateStart);
    if (dateEnd) where.scheduledAt.lte = new Date(dateEnd);
  }

  const [total, sessions] = await Promise.all([
    prisma.interviewSession.count({ where }),
    prisma.interviewSession.findMany({
      where,
      orderBy: { scheduledAt: 'desc' },
      skip: (pageNum - 1) * limitNum,
      take: limitNum,
      include: {
        _count: { select: { candidates: true } },
        candidates: { select: { status: true } },
        questionSet: { select: { _count: { select: { questions: true } } } },
      },
    }),
  ]);

  res.json({
    data: sessions.map((s) => {
      const { candidates, ...rest } = s;
      return {
        ...rest,
        candidateCount: s._count.candidates,
        completedCount: candidates.filter((c) => c.status === 'COMPLETED').length,
        questionCount: s.questionSet?._count.questions ?? 0,
      };
    }),
    total,
    page: pageNum,
    limit: limitNum,
    totalPages: Math.ceil(total / limitNum) || 1,
  });
};

export const getUpcoming = async (req: AuthRequest, res: Response) => {
  const rows = await prisma.sessionCandidate.findMany({
    where: {
      status: { in: ['INVITED', 'JOINED', 'IN_PROGRESS'] },
      interviewSession: { userId: req.user!.userId, scheduledAt: { gte: new Date(Date.now() - 60 * 60_000) } },
    },
    include: { candidate: true, interviewSession: true },
    orderBy: { interviewSession: { scheduledAt: 'asc' } },
    take: 8,
  });

  res.json(rows);
};

export const getSession = async (req: AuthRequest, res: Response) => {
  const session = await prisma.interviewSession.findFirst({
    where: { id: param(req, 'id'), userId: req.user!.userId },
    include: {
      candidates: {
        include: {
          candidate: true,
          report: { select: { id: true, overallRating: true, hiringRecommendation: true } },
          _count: { select: { submissions: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
      questionSet: { include: { questions: { orderBy: { order: 'asc' } } } },
    },
  });

  if (!session) throw notFound('Session not found');

  res.json({
    ...session,
    candidates: session.candidates.map((c) => ({
      ...c,
      // The join link is per-candidate, not per-session.
      joinUrl: `/interview/${c.accessToken}`,
    })),
  });
};

const updateSchema = createSchema
  .partial()
  .omit({ generateQuestions: true, meetingProvider: true })
  .extend({ status: z.enum(['DRAFT', 'SCHEDULED', 'ACTIVE', 'COMPLETED', 'CANCELLED']).optional() });

export const updateSession = async (req: AuthRequest, res: Response) => {
  const data = updateSchema.parse(req.body);

  const existing = await prisma.interviewSession.findFirst({
    where: { id: param(req, 'id'), userId: req.user!.userId },
  });
  if (!existing) throw notFound('Session not found');

  const patch: Prisma.InterviewSessionUpdateInput = {};
  if (data.title !== undefined) patch.title = data.title;
  if (data.jobDescription !== undefined) patch.jobDescription = data.jobDescription;
  if (data.skills !== undefined) patch.skills = data.skills;
  if (data.experienceLevel !== undefined) patch.experienceLevel = data.experienceLevel;
  if (data.type !== undefined) patch.type = data.type;
  if (data.durationMinutes !== undefined) patch.durationMinutes = data.durationMinutes;
  if (data.personality !== undefined) patch.personality = data.personality;
  if (data.language !== undefined) patch.language = data.language;
  if (data.codingEnabled !== undefined) patch.codingEnabled = data.codingEnabled;
  if (data.videoAnalysisEnabled !== undefined) patch.videoAnalysisEnabled = data.videoAnalysisEnabled;
  if (data.recordingEnabled !== undefined) patch.recordingEnabled = data.recordingEnabled;
  if (data.passMark !== undefined) patch.passMark = data.passMark;
  if (data.status !== undefined) patch.status = data.status;

  let rescheduled = false;
  if (data.scheduledAt) {
    const when = new Date(data.scheduledAt);
    if (Number.isNaN(when.getTime())) throw badRequest('scheduledAt is not a valid date');
    patch.scheduledAt = when;
    rescheduled = when.getTime() !== existing.scheduledAt.getTime();
  }

  const session = await prisma.interviewSession.update({ where: { id: existing.id }, data: patch });

  if (rescheduled) await SchedulerService.reschedule(session.id);

  res.json(session);
};

export const cancelSession = async (req: AuthRequest, res: Response) => {
  const existing = await prisma.interviewSession.findFirst({
    where: { id: param(req, 'id'), userId: req.user!.userId },
  });
  if (!existing) throw notFound('Session not found');

  const session = await prisma.interviewSession.update({
    where: { id: existing.id },
    data: { status: 'CANCELLED' },
  });

  // Stop chasing candidates for an interview that will not happen.
  await SchedulerService.cancelForSession(session.id);
  await prisma.sessionCandidate.updateMany({
    where: { interviewSessionId: session.id, status: { in: ['INVITED', 'JOINED'] } },
    data: { status: 'CANCELLED' },
  });

  res.json(session);
};

export const deleteSession = async (req: AuthRequest, res: Response) => {
  const existing = await prisma.interviewSession.findFirst({
    where: { id: param(req, 'id'), userId: req.user!.userId },
  });
  if (!existing) throw notFound('Session not found');

  await prisma.interviewSession.delete({ where: { id: existing.id } });
  res.json({ ok: true });
};

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export const generateQuestions = async (req: AuthRequest, res: Response) => {
  // Regenerating replaces the whole set, so it is the most destructive of the
  // question routes and needs the same guard as the others.
  await assertNotStarted(param(req, 'id'), req.user!.userId);

  const session = await prisma.interviewSession.findFirst({
    where: { id: param(req, 'id'), userId: req.user!.userId },
  });
  if (!session) throw notFound('Session not found');

  const questionSetId = await QuestionGenerationService.generateAndSave(session.id);

  const set = await prisma.questionSet.findUnique({
    where: { id: questionSetId },
    include: { questions: { orderBy: { order: 'asc' } } },
  });

  res.json(set);
};

/**
 * The coding-exercise payload, as the editor and the candidate's tab both see
 * it.
 *
 * Kept explicit rather than passing `meta` through as free-form JSON: this
 * object is what the code runner grades against, so a recruiter who mistypes a
 * field name would otherwise produce an exercise that silently fails every
 * submission.
 */
const codingMetaSchema = z.object({
  title: z.string().min(2).optional(),
  constraints: z.array(z.string()).optional(),
  starterCode: z.string().optional(),
  optimalTime: z.string().optional(),
  optimalSpace: z.string().optional(),
  testCases: z
    .array(
      z.object({
        input: z.string(),
        output: z.string(),
        /// Hidden cases are graded but never shown to the candidate.
        hidden: z.boolean().optional(),
      }),
    )
    .optional(),
});

const questionPatchSchema = z.object({
  content: z.string().min(5).optional(),
  expectedAnswer: z.string().optional(),
  difficulty: z.enum(['EASY', 'MEDIUM', 'HARD']).optional(),
  skill: z.string().optional(),
  meta: codingMetaSchema.optional(),
});

/**
 * Refuses to touch the question set once the interview is under way.
 *
 * The state machine reads its questions when the interview starts and works
 * from that list. Editing afterwards changes what the report is written
 * against but not what was actually asked, which is the sort of mismatch
 * nobody ever discovers until they are defending a hiring decision.
 */
async function assertNotStarted(sessionId: string, userId: string) {
  const started = await prisma.sessionCandidate.findFirst({
    where: {
      interviewSessionId: sessionId,
      interviewSession: { userId },
      // Everything except the states that mean the interviewer never spoke to
      // them: still waiting, never turned up, or called off.
      status: { notIn: ['INVITED', 'ABSENT', 'CANCELLED'] },
    },
    select: { id: true },
  });

  if (started) {
    throw badRequest('This interview has already started, so its questions can no longer be changed.');
  }
}

export const updateQuestion = async (req: AuthRequest, res: Response) => {
  const data = questionPatchSchema.parse(req.body);
  await assertNotStarted(param(req, 'id'), req.user!.userId);

  // Ownership is enforced through the session, not the question id.
  const question = await prisma.question.findFirst({
    where: {
      id: param(req, 'questionId'),
      questionSet: { interviewSession: { id: param(req, 'id'), userId: req.user!.userId } },
    },
  });
  if (!question) throw notFound('Question not found');

  const { meta, ...rest } = data;

  res.json(
    await prisma.question.update({
      where: { id: question.id },
      data: {
        ...rest,
        // Merged, not replaced: the editor sends only the fields it shows, and
        // the generator writes others (redFlags, expectedPoints) that nothing
        // in the UI would put back.
        ...(meta ? { meta: { ...(question.meta as object | null), ...meta } } : {}),
      },
    }),
  );
};

export const deleteQuestion = async (req: AuthRequest, res: Response) => {
  await assertNotStarted(param(req, 'id'), req.user!.userId);

  const question = await prisma.question.findFirst({
    where: {
      id: param(req, 'questionId'),
      questionSet: { interviewSession: { id: param(req, 'id'), userId: req.user!.userId } },
    },
  });
  if (!question) throw notFound('Question not found');

  await prisma.question.delete({ where: { id: question.id } });
  res.json({ ok: true });
};

const addQuestionSchema = z.object({
  content: z.string().min(5),
  category: z.enum(['INTRO', 'IDENTITY', 'HR', 'TECHNICAL', 'SCENARIO', 'PROJECT', 'CODING', 'CLOSING']),
  difficulty: z.enum(['EASY', 'MEDIUM', 'HARD']).default('MEDIUM'),
  skill: z.string().optional(),
  expectedAnswer: z.string().optional(),
  meta: codingMetaSchema.optional(),
});

export const addQuestion = async (req: AuthRequest, res: Response) => {
  const data = addQuestionSchema.parse(req.body);
  await assertNotStarted(param(req, 'id'), req.user!.userId);

  const session = await prisma.interviewSession.findFirst({
    where: { id: param(req, 'id'), userId: req.user!.userId },
    include: { questionSet: { include: { _count: { select: { questions: true } } } } },
  });
  if (!session) throw notFound('Session not found');

  const set =
    session.questionSet ??
    (await prisma.questionSet.create({ data: { interviewSessionId: session.id, generatedBy: 'manual' } }));

  const order = session.questionSet?._count.questions ?? 0;

  res.status(201).json(
    await prisma.question.create({
      data: {
        questionSetId: set.id,
        content: data.content,
        category: data.category,
        difficulty: data.difficulty,
        skill: data.skill ?? null,
        expectedAnswer: data.expectedAnswer ?? null,
        meta: data.meta ?? undefined,
        order,
      },
    }),
  );
};

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

export const getLeaderboard = async (req: AuthRequest, res: Response) => {
  const session = await prisma.interviewSession.findFirst({
    where: { id: param(req, 'id'), userId: req.user!.userId },
    select: { id: true },
  });
  if (!session) throw notFound('Session not found');

  res.json(await RankingService.rankSession(session.id));
};

export const getShortlist = async (req: AuthRequest, res: Response) => {
  const session = await prisma.interviewSession.findFirst({
    where: { id: param(req, 'id'), userId: req.user!.userId },
    select: { id: true },
  });
  if (!session) throw notFound('Session not found');

  const limit = Math.min(20, parseInt(String(req.query.limit ?? '5'), 10) || 5);
  res.json(await RankingService.shortlist(session.id, limit));
};

export const compareCandidates = async (req: AuthRequest, res: Response) => {
  const ids = z.array(z.string().uuid()).min(2).max(6).parse(req.body.sessionCandidateIds);

  // Confirm every id belongs to a session this user owns.
  const owned = await prisma.sessionCandidate.count({
    where: { id: { in: ids }, interviewSession: { userId: req.user!.userId } },
  });
  if (owned !== ids.length) throw notFound('One or more candidates were not found');

  res.json(await RankingService.compare(ids));
};
