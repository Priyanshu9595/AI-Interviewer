import { Response } from 'express';
import { z } from 'zod';
import { AuthRequest } from '../lib/auth';
import { emailService } from '../lib/email/EmailService';
import { env } from '../lib/env';
import { badRequest, notFound, param } from '../lib/http';
import { prisma } from '../lib/prisma';
import { AtsService } from '../services/AtsService';
import { ExportService } from '../services/ExportService';

const ownedReport = (userId: string, reportId: string) =>
  prisma.report.findFirst({
    where: { id: reportId, sessionCandidate: { interviewSession: { userId } } },
  });

export const listRecentReports = async (req: AuthRequest, res: Response) => {
  const limit = Math.min(50, parseInt(String(req.query.limit ?? '10'), 10) || 10);

  const reports = await prisma.report.findMany({
    where: { sessionCandidate: { interviewSession: { userId: req.user!.userId } } },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      sessionCandidate: {
        include: {
          candidate: { select: { name: true, email: true } },
          interviewSession: { select: { id: true, title: true, type: true } },
        },
      },
    },
  });

  res.json(reports);
};

export const getReport = async (req: AuthRequest, res: Response) => {
  const report = await prisma.report.findFirst({
    where: { id: param(req, 'id'), sessionCandidate: { interviewSession: { userId: req.user!.userId } } },
    include: {
      scores: true,
      sessionCandidate: {
        include: {
          candidate: true,
          interviewSession: true,
          recording: { select: { id: true, durationSeconds: true, mimeType: true } },
          submissions: {
            include: { question: { select: { content: true, meta: true } } },
            orderBy: { createdAt: 'asc' },
          },
          transcript: { include: { turns: { orderBy: { timestamp: 'asc' } } } },
          insights: { orderBy: { createdAt: 'asc' } },
        },
      },
    },
  });

  if (!report) throw notFound('Report not found');

  // Group the flat score rows so the UI does not have to.
  const scoresByCategory = report.scores.reduce<Record<string, Array<{ label: string; value: number; evidence: string | null }>>>(
    (acc, s) => {
      (acc[s.category] ??= []).push({ label: s.label, value: s.value, evidence: s.evidence });
      return acc;
    },
    {},
  );

  res.json({ ...report, scoresByCategory });
};

export const getReportByCandidate = async (req: AuthRequest, res: Response) => {
  const report = await prisma.report.findFirst({
    where: {
      sessionCandidateId: param(req, 'sessionCandidateId'),
      sessionCandidate: { interviewSession: { userId: req.user!.userId } },
    },
    select: { id: true },
  });
  if (!report) throw notFound('No report has been generated for this interview yet');

  res.json({ reportId: report.id });
};

export const downloadReportPdf = async (req: AuthRequest, res: Response) => {
  const report = await ownedReport(req.user!.userId, param(req, 'id'));
  if (!report) throw notFound('Report not found');

  await ExportService.reportPdf(report.id, res);
};

export const downloadReportExcel = async (req: AuthRequest, res: Response) => {
  const report = await ownedReport(req.user!.userId, param(req, 'id'));
  if (!report) throw notFound('Report not found');

  await ExportService.reportExcel(report.id, res);
};

export const downloadSessionExcel = async (req: AuthRequest, res: Response) => {
  const session = await prisma.interviewSession.findFirst({
    where: { id: param(req, 'id'), userId: req.user!.userId },
    select: { id: true },
  });
  if (!session) throw notFound('Session not found');

  await ExportService.sessionExcel(session.id, res);
};

/** Sends the candidate their feedback email. */
export const sendFeedbackEmail = async (req: AuthRequest, res: Response) => {
  const { force } = z.object({ force: z.boolean().default(false) }).parse(req.body ?? {});

  const report = await prisma.report.findFirst({
    where: { id: param(req, 'id'), sessionCandidate: { interviewSession: { userId: req.user!.userId } } },
    include: {
      sessionCandidate: { include: { candidate: true, interviewSession: true } },
    },
  });
  if (!report) throw notFound('Report not found');

  if (report.feedbackEmailSentAt && !force) {
    throw badRequest(
      `Feedback was already emailed on ${report.feedbackEmailSentAt.toLocaleString()}. Pass force to send it again.`,
    );
  }

  const details = (report.details ?? {}) as {
    strengths?: Array<{ point: string }>;
    improvements?: string[];
  };

  await emailService.sendFeedback({
    to: report.sessionCandidate.candidate.email,
    name: report.sessionCandidate.candidate.name,
    role: report.sessionCandidate.interviewSession.title,
    overall: report.overallRating,
    strengths: (details.strengths ?? []).map((s) => s.point).slice(0, 4),
    improvements: (details.improvements ?? []).slice(0, 4),
    message:
      report.candidateFeedback ||
      'Thank you again for your time. The hiring team will be in touch about next steps.',
  });

  await prisma.report.update({ where: { id: report.id }, data: { feedbackEmailSentAt: new Date() } });

  res.json({ ok: true, sentTo: report.sessionCandidate.candidate.email });
};

/** Pushes a report to every enabled ATS integration. */
export const syncReportToAts = async (req: AuthRequest, res: Response) => {
  const report = await ownedReport(req.user!.userId, param(req, 'id'));
  if (!report) throw notFound('Report not found');

  const results = await AtsService.syncAll(req.user!.userId, report.id, env.APP_URL);
  if (!results.length) throw badRequest('No enabled ATS integrations are configured');

  res.json({ results });
};
