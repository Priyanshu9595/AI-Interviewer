import { Response } from 'express';
import Papa from 'papaparse';
import * as xlsx from 'xlsx';
import { z } from 'zod';
import { AuthRequest } from '../lib/auth';
import { badRequest, conflict, notFound, param } from '../lib/http';
import { prisma } from '../lib/prisma';
import { SchedulerService } from '../services/SchedulerService';

const candidateSchema = z.object({
  name: z.string().min(1, 'Name is required').transform((s) => s.trim()),
  email: z
    .string()
    .email('Invalid email address')
    .transform((s) => s.toLowerCase().trim()),
  mobile: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => (v === undefined || v === '' ? null : String(v).trim())),
});

/** Accepts the header spellings people actually put in spreadsheets. */
function readRow(row: Record<string, unknown>) {
  const get = (...keys: string[]) => {
    for (const key of Object.keys(row)) {
      const normalised = key.toLowerCase().replace(/[\s_-]/g, '');
      if (keys.includes(normalised)) {
        const value = row[key];
        if (value !== undefined && value !== null && String(value).trim() !== '') return value;
      }
    }
    return undefined;
  };

  return {
    name: get('name', 'candidatename', 'fullname', 'candidate'),
    email: get('email', 'emailaddress', 'mail', 'candidateemail'),
    mobile: get('mobile', 'phone', 'phonenumber', 'mobilenumber', 'contact', 'contactnumber'),
  };
}

async function assertOwnsSession(userId: string, sessionId: string) {
  const session = await prisma.interviewSession.findFirst({ where: { id: sessionId, userId } });
  if (!session) throw notFound('Session not found');
  return session;
}

/** Creates or reuses the candidate, links them to the session, queues emails. */
async function attach(sessionId: string, input: z.infer<typeof candidateSchema>) {
  const candidate = await prisma.candidate.upsert({
    where: { email: input.email },
    create: { name: input.name, email: input.email, mobile: input.mobile },
    // Keep the newest name/mobile we have been given for a returning candidate.
    update: { name: input.name, ...(input.mobile ? { mobile: input.mobile } : {}) },
  });

  const existing = await prisma.sessionCandidate.findUnique({
    where: { interviewSessionId_candidateId: { interviewSessionId: sessionId, candidateId: candidate.id } },
  });
  if (existing) throw conflict('That candidate is already in this session');

  const sessionCandidate = await prisma.sessionCandidate.create({
    data: { interviewSessionId: sessionId, candidateId: candidate.id, status: 'INVITED' },
    include: { candidate: true },
  });

  await SchedulerService.scheduleFor(sessionCandidate.id);

  return sessionCandidate;
}

export const addCandidate = async (req: AuthRequest, res: Response) => {
  await assertOwnsSession(req.user!.userId, param(req, 'id'));
  const data = candidateSchema.parse(req.body);

  const sessionCandidate = await attach(param(req, 'id'), data);
  res.status(201).json({ ...sessionCandidate, joinUrl: `/interview/${sessionCandidate.accessToken}` });
};

export const bulkUploadCandidates = async (req: AuthRequest, res: Response) => {
  await assertOwnsSession(req.user!.userId, param(req, 'id'));

  const file = (req as unknown as { file?: Express.Multer.File }).file;
  if (!file) throw badRequest('No file uploaded');

  const ext = file.originalname.split('.').pop()?.toLowerCase();
  let rows: Record<string, unknown>[] = [];

  if (ext === 'csv' || ext === 'txt') {
    const parsed = Papa.parse<Record<string, unknown>>(file.buffer.toString('utf-8'), {
      header: true,
      skipEmptyLines: 'greedy',
    });
    rows = parsed.data;
  } else if (ext === 'xlsx' || ext === 'xls') {
    const wb = xlsx.read(file.buffer, { type: 'buffer' });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) throw badRequest('The workbook has no sheets');
    const sheet = wb.Sheets[sheetName];
    if (!sheet) throw badRequest('The first sheet could not be read');
    rows = xlsx.utils.sheet_to_json<Record<string, unknown>>(sheet);
  } else {
    throw badRequest('Unsupported file type. Upload a .csv, .xlsx or .xls file.');
  }

  if (!rows.length) throw badRequest('The file contains no rows');
  if (rows.length > 1000) throw badRequest('Please upload at most 1000 candidates at a time');

  const inserted: Array<{ name: string; email: string }> = [];
  const errors: Array<{ row: number; email?: string; message: string }> = [];
  const seen = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    // +2 because row 1 is the header and spreadsheets are 1-indexed.
    const rowNumber = i + 2;
    const raw = readRow(rows[i] ?? {});

    try {
      const data = candidateSchema.parse(raw);

      if (seen.has(data.email)) {
        errors.push({ row: rowNumber, email: data.email, message: 'Duplicate row in this file' });
        continue;
      }
      seen.add(data.email);

      const sc = await attach(param(req, 'id'), data);
      inserted.push({ name: sc.candidate.name, email: sc.candidate.email });
    } catch (err) {
      const message =
        err instanceof z.ZodError
          ? err.issues.map((issue) => issue.message).join('; ')
          : (err as Error).message;
      errors.push({ row: rowNumber, email: raw.email ? String(raw.email) : undefined, message });
    }
  }

  res.json({ inserted: inserted.length, skipped: errors.length, candidates: inserted, errors });
};

export const listSessionCandidates = async (req: AuthRequest, res: Response) => {
  await assertOwnsSession(req.user!.userId, param(req, 'id'));

  const rows = await prisma.sessionCandidate.findMany({
    where: { interviewSessionId: param(req, 'id') },
    include: {
      candidate: true,
      report: { select: { id: true, overallRating: true, hiringRecommendation: true } },
      reminders: { select: { kind: true, status: true, scheduledFor: true, sentAt: true } },
      _count: { select: { submissions: true, insights: true } },
    },
    // The parsed text is large and never needed in a list view.
    omit: { resumeText: true, resumeProfile: true, resumeQuestions: true },
    orderBy: { createdAt: 'asc' },
  });

  res.json(rows.map((r) => ({ ...r, joinUrl: `/interview/${r.accessToken}` })));
};

export const removeSessionCandidate = async (req: AuthRequest, res: Response) => {
  const row = await prisma.sessionCandidate.findFirst({
    where: { id: param(req, 'candidateId'), interviewSession: { userId: req.user!.userId } },
  });
  if (!row) throw notFound('Candidate not found in this session');

  await prisma.sessionCandidate.delete({ where: { id: row.id } });
  res.json({ ok: true });
};

/** Re-queues the invite email, e.g. after a bounced address is corrected. */
export const resendInvite = async (req: AuthRequest, res: Response) => {
  const row = await prisma.sessionCandidate.findFirst({
    where: { id: param(req, 'candidateId'), interviewSession: { userId: req.user!.userId } },
  });
  if (!row) throw notFound('Candidate not found in this session');

  await prisma.reminder.upsert({
    where: { sessionCandidateId_kind: { sessionCandidateId: row.id, kind: 'INVITE' } },
    create: { sessionCandidateId: row.id, kind: 'INVITE', scheduledFor: new Date(), status: 'PENDING' },
    update: { status: 'PENDING', scheduledFor: new Date(), attempts: 0, error: null },
  });

  // Fire immediately rather than waiting for the next scheduler tick.
  void SchedulerService.tick();

  res.json({ ok: true, message: 'Invite queued for delivery' });
};

/** All candidates across the recruiter's sessions, for the directory view. */
export const listAllCandidates = async (req: AuthRequest, res: Response) => {
  const { search, page = '1', limit = '20' } = req.query as Record<string, string>;
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

  const where = {
    sessions: { some: { interviewSession: { userId: req.user!.userId } } },
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' as const } },
            { email: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const [total, candidates] = await Promise.all([
    prisma.candidate.count({ where }),
    prisma.candidate.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (pageNum - 1) * limitNum,
      take: limitNum,
      include: {
        sessions: {
          where: { interviewSession: { userId: req.user!.userId } },
          include: {
            interviewSession: { select: { id: true, title: true, scheduledAt: true } },
            report: { select: { id: true, overallRating: true, hiringRecommendation: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    }),
  ]);

  res.json({
    data: candidates,
    total,
    page: pageNum,
    totalPages: Math.ceil(total / limitNum) || 1,
  });
};
