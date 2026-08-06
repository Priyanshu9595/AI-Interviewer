import { HiringRecommendation } from '@prisma/client';
import { prisma } from '../lib/prisma';

const RECOMMENDATION_RANK: Record<HiringRecommendation, number> = {
  STRONG_HIRE: 4,
  HIRE: 3,
  CONSIDER: 2,
  REJECT: 1,
};

export interface RankedCandidate {
  rank: number;
  sessionCandidateId: string;
  candidateId: string;
  name: string;
  email: string;
  mobile: string | null;
  status: string;
  reportId: string | null;
  overall: number;
  technical: number;
  communication: number;
  behavioral: number;
  coding: number | null;
  videoConfidence: number | null;
  recommendation: HiringRecommendation | null;
  recommendationReason: string | null;
  summary: string | null;
  strengths: string[];
  weaknesses: string[];
  skills: Array<{ skill: string; score: number }>;
  completedAt: Date | null;
  durationMinutes: number | null;
}

type ReportDetails = {
  strengths?: Array<{ point: string }>;
  weaknesses?: Array<{ point: string }>;
  skillBreakdown?: Array<{ skill: string; score: number }>;
  meta?: { durationMinutes?: number | null };
};

export class RankingService {
  /**
   * Ranks every evaluated candidate in a session. Ordering is by hiring
   * recommendation first, then overall score — a Hire always outranks a
   * Consider even if the raw numbers are close, because the recommendation
   * encodes the hard gates (red flags, technical floor).
   */
  static async rankSession(interviewSessionId: string): Promise<RankedCandidate[]> {
    const rows = await prisma.sessionCandidate.findMany({
      where: { interviewSessionId },
      include: { candidate: true, report: true },
    });

    const ranked = rows
      .map((sc) => {
        const details = (sc.report?.details ?? {}) as ReportDetails;

        return {
          sessionCandidateId: sc.id,
          candidateId: sc.candidateId,
          name: sc.candidate.name,
          email: sc.candidate.email,
          mobile: sc.candidate.mobile,
          status: sc.status,
          reportId: sc.report?.id ?? null,
          overall: sc.report?.overallRating ?? 0,
          technical: sc.report?.technicalScore ?? 0,
          communication: sc.report?.communicationScore ?? 0,
          behavioral: sc.report?.behavioralScore ?? 0,
          coding: sc.report?.codingScore ?? null,
          videoConfidence: sc.report?.videoConfidenceScore ?? null,
          recommendation: sc.report?.hiringRecommendation ?? null,
          recommendationReason: sc.report?.recommendationReason ?? null,
          summary: sc.report?.summary ?? null,
          strengths: (details.strengths ?? []).map((s) => s.point).slice(0, 3),
          weaknesses: (details.weaknesses ?? []).map((s) => s.point).slice(0, 3),
          skills: details.skillBreakdown ?? [],
          completedAt: sc.completedAt,
          durationMinutes: details.meta?.durationMinutes ?? null,
        };
      })
      .sort((a, b) => {
        // Unevaluated candidates always sink to the bottom.
        if (!a.reportId && !b.reportId) return a.name.localeCompare(b.name);
        if (!a.reportId) return 1;
        if (!b.reportId) return -1;

        const recDiff =
          RECOMMENDATION_RANK[b.recommendation ?? 'REJECT'] - RECOMMENDATION_RANK[a.recommendation ?? 'REJECT'];
        if (recDiff !== 0) return recDiff;

        if (b.overall !== a.overall) return b.overall - a.overall;
        return b.technical - a.technical;
      });

    return ranked.map((r, i) => ({ ...r, rank: r.reportId ? i + 1 : 0 }));
  }

  /** Side-by-side view of specific candidates for the compare screen. */
  static async compare(sessionCandidateIds: string[]) {
    const rows = await prisma.sessionCandidate.findMany({
      where: { id: { in: sessionCandidateIds } },
      include: { candidate: true, report: { include: { scores: true } } },
    });

    return rows.map((sc) => ({
      sessionCandidateId: sc.id,
      name: sc.candidate.name,
      email: sc.candidate.email,
      status: sc.status,
      report: sc.report,
      // Grouped so the UI can render one radar per dimension without regrouping.
      scoresByCategory: (sc.report?.scores ?? []).reduce<Record<string, Array<{ label: string; value: number }>>>(
        (acc, s) => {
          (acc[s.category] ??= []).push({ label: s.label, value: s.value });
          return acc;
        },
        {},
      ),
    }));
  }

  /** Shortlist for the "AI hiring assistant" view. */
  static async shortlist(interviewSessionId: string, limit = 5) {
    const ranked = await this.rankSession(interviewSessionId);
    const eligible = ranked.filter(
      (r) => r.reportId && (r.recommendation === 'STRONG_HIRE' || r.recommendation === 'HIRE'),
    );

    const pool = eligible.length ? eligible : ranked.filter((r) => r.reportId && r.recommendation === 'CONSIDER');

    return {
      shortlisted: pool.slice(0, limit),
      totalEvaluated: ranked.filter((r) => r.reportId).length,
      totalCandidates: ranked.length,
      /** Honest note when the shortlist is weaker than a recruiter might assume. */
      note: eligible.length
        ? `${eligible.length} candidate(s) cleared the hiring bar.`
        : pool.length
          ? 'No candidate reached Hire. These are the strongest of those worth a second look.'
          : 'No candidate met the bar for this role.',
    };
  }
}
