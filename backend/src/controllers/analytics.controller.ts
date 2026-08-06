import { Response } from 'express';
import { AuthRequest } from '../lib/auth';
import { prisma } from '../lib/prisma';

const round1 = (n: number) => Math.round(n * 10) / 10;

export const getOverview = async (req: AuthRequest, res: Response) => {
  const userId = req.user!.userId;
  const scope = { interviewSession: { userId } };

  const [
    totalSessions,
    activeSessions,
    totalCandidates,
    completed,
    absent,
    pending,
    inProgress,
    reports,
  ] = await Promise.all([
    prisma.interviewSession.count({ where: { userId } }),
    prisma.interviewSession.count({ where: { userId, status: { in: ['SCHEDULED', 'ACTIVE'] } } }),
    prisma.sessionCandidate.count({ where: scope }),
    prisma.sessionCandidate.count({ where: { ...scope, status: 'COMPLETED' } }),
    prisma.sessionCandidate.count({ where: { ...scope, status: 'ABSENT' } }),
    prisma.sessionCandidate.count({ where: { ...scope, status: 'INVITED' } }),
    prisma.sessionCandidate.count({ where: { ...scope, status: 'IN_PROGRESS' } }),
    prisma.report.findMany({
      where: { sessionCandidate: scope },
      select: {
        overallRating: true,
        technicalScore: true,
        communicationScore: true,
        behavioralScore: true,
        codingScore: true,
        hiringRecommendation: true,
        createdAt: true,
      },
    }),
  ]);

  const n = reports.length;
  const sum = reports.reduce(
    (acc, r) => ({
      overall: acc.overall + r.overallRating,
      technical: acc.technical + r.technicalScore,
      communication: acc.communication + r.communicationScore,
      behavioral: acc.behavioral + r.behavioralScore,
      coding: acc.coding + (r.codingScore ?? 0),
      codingCount: acc.codingCount + (r.codingScore != null ? 1 : 0),
    }),
    { overall: 0, technical: 0, communication: 0, behavioral: 0, coding: 0, codingCount: 0 },
  );

  const recommendationDistribution = { STRONG_HIRE: 0, HIRE: 0, CONSIDER: 0, REJECT: 0 };
  for (const r of reports) recommendationDistribution[r.hiringRecommendation]++;

  // Fourteen-day activity trend, bucketed in memory to avoid 14 round-trips.
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - 13);

  const recentCandidates = await prisma.sessionCandidate.findMany({
    where: { ...scope, OR: [{ createdAt: { gte: since } }, { completedAt: { gte: since } }] },
    select: { createdAt: true, completedAt: true, status: true },
  });

  const key = (d: Date) => d.toISOString().slice(0, 10);
  const buckets = new Map<string, { date: string; invited: number; completed: number }>();

  for (let i = 0; i < 14; i++) {
    const d = new Date(since);
    d.setDate(since.getDate() + i);
    buckets.set(key(d), {
      date: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      invited: 0,
      completed: 0,
    });
  }

  for (const c of recentCandidates) {
    const created = buckets.get(key(c.createdAt));
    if (created) created.invited++;
    if (c.completedAt) {
      const done = buckets.get(key(c.completedAt));
      if (done) done.completed++;
    }
  }

  res.json({
    totals: {
      sessions: totalSessions,
      activeSessions,
      candidates: totalCandidates,
      completed,
      absent,
      pending,
      inProgress,
      reports: n,
    },
    rates: {
      completion: totalCandidates ? round1((completed / totalCandidates) * 100) : 0,
      noShow: totalCandidates ? round1((absent / totalCandidates) * 100) : 0,
      hireRate: n ? round1(((recommendationDistribution.STRONG_HIRE + recommendationDistribution.HIRE) / n) * 100) : 0,
    },
    avgScores: {
      overall: n ? round1(sum.overall / n) : 0,
      technical: n ? round1(sum.technical / n) : 0,
      communication: n ? round1(sum.communication / n) : 0,
      behavioral: n ? round1(sum.behavioral / n) : 0,
      coding: sum.codingCount ? round1(sum.coding / sum.codingCount) : 0,
    },
    recommendationDistribution,
    activity: [...buckets.values()],
  });
};

/** Which skills the candidate pool is strong and weak in. */
export const getSkillAnalytics = async (req: AuthRequest, res: Response) => {
  const rows = await prisma.score.findMany({
    where: {
      category: 'Skill',
      report: { sessionCandidate: { interviewSession: { userId: req.user!.userId } } },
    },
    select: { label: true, value: true },
  });

  const bySkill = new Map<string, { total: number; count: number }>();
  for (const row of rows) {
    const key = row.label.trim().toLowerCase();
    const entry = bySkill.get(key) ?? { total: 0, count: 0 };
    entry.total += row.value;
    entry.count++;
    bySkill.set(key, entry);
  }

  const skills = [...bySkill.entries()]
    .map(([skill, { total, count }]) => ({
      skill: skill.replace(/\b\w/g, (c) => c.toUpperCase()),
      average: round1(total / count),
      assessed: count,
    }))
    // A single data point is noise, not a trend.
    .filter((s) => s.assessed >= 1)
    .sort((a, b) => b.average - a.average);

  res.json({
    skills,
    strongest: skills.slice(0, 5),
    weakest: [...skills].reverse().slice(0, 5),
  });
};

/** Per-session comparison table for the analytics page. */
export const getSessionAnalytics = async (req: AuthRequest, res: Response) => {
  const sessions = await prisma.interviewSession.findMany({
    where: { userId: req.user!.userId },
    orderBy: { scheduledAt: 'desc' },
    take: 20,
    include: {
      candidates: {
        select: {
          status: true,
          report: { select: { overallRating: true, hiringRecommendation: true } },
        },
      },
    },
  });

  res.json(
    sessions.map((s) => {
      const evaluated = s.candidates.filter((c) => c.report);
      const avg = evaluated.length
        ? evaluated.reduce((a, c) => a + (c.report?.overallRating ?? 0), 0) / evaluated.length
        : 0;

      return {
        id: s.id,
        title: s.title,
        type: s.type,
        status: s.status,
        scheduledAt: s.scheduledAt,
        candidates: s.candidates.length,
        completed: s.candidates.filter((c) => c.status === 'COMPLETED').length,
        absent: s.candidates.filter((c) => c.status === 'ABSENT').length,
        evaluated: evaluated.length,
        avgOverall: round1(avg),
        hires: evaluated.filter(
          (c) => c.report?.hiringRecommendation === 'HIRE' || c.report?.hiringRecommendation === 'STRONG_HIRE',
        ).length,
      };
    }),
  );
};
