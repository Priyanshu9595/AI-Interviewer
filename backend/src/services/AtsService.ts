import { AtsProvider } from '@prisma/client';
import { prisma } from '../lib/prisma';

/** Normalised payload every provider receives. */
export interface AtsPayload {
  event: 'interview.completed';
  candidate: { name: string; email: string; mobile: string | null };
  job: { title: string; experienceLevel: string; skills: string[] };
  interview: { completedAt: string | null; durationMinutes: number | null; type: string };
  scores: {
    overall: number;
    technical: number;
    communication: number;
    behavioral: number;
    coding: number | null;
  };
  recommendation: string;
  recommendationReason: string | null;
  summary: string | null;
  strengths: string[];
  weaknesses: string[];
  reportUrl: string;
}

export class AtsService {
  static async listIntegrations(userId: string) {
    const rows = await prisma.atsIntegration.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { syncLogs: true } } },
    });

    // Never return the stored secret.
    return rows.map(({ apiKey, ...rest }) => ({ ...rest, hasApiKey: Boolean(apiKey) }));
  }

  static async createIntegration(args: {
    userId: string;
    provider: AtsProvider;
    name: string;
    webhookUrl?: string;
    apiKey?: string;
  }) {
    const row = await prisma.atsIntegration.create({
      data: {
        userId: args.userId,
        provider: args.provider,
        name: args.name,
        webhookUrl: args.webhookUrl ?? null,
        apiKey: args.apiKey ?? null,
      },
    });
    const { apiKey, ...safe } = row;
    return { ...safe, hasApiKey: Boolean(apiKey) };
  }

  static async deleteIntegration(userId: string, id: string) {
    await prisma.atsIntegration.deleteMany({ where: { id, userId } });
  }

  private static buildPayload(report: {
    overallRating: number;
    technicalScore: number;
    communicationScore: number;
    behavioralScore: number;
    codingScore: number | null;
    hiringRecommendation: string;
    recommendationReason: string | null;
    summary: string | null;
    details: unknown;
    id: string;
    sessionCandidate: {
      completedAt: Date | null;
      candidate: { name: string; email: string; mobile: string | null };
      interviewSession: { title: string; experienceLevel: string; skills: string[]; type: string };
    };
  }, appUrl: string): AtsPayload {
    const details = (report.details ?? {}) as {
      strengths?: Array<{ point: string }>;
      weaknesses?: Array<{ point: string }>;
      meta?: { durationMinutes?: number | null };
    };

    const sc = report.sessionCandidate;

    return {
      event: 'interview.completed',
      candidate: { name: sc.candidate.name, email: sc.candidate.email, mobile: sc.candidate.mobile },
      job: {
        title: sc.interviewSession.title,
        experienceLevel: sc.interviewSession.experienceLevel,
        skills: sc.interviewSession.skills,
      },
      interview: {
        completedAt: sc.completedAt?.toISOString() ?? null,
        durationMinutes: details.meta?.durationMinutes ?? null,
        type: sc.interviewSession.type,
      },
      scores: {
        overall: report.overallRating,
        technical: report.technicalScore,
        communication: report.communicationScore,
        behavioral: report.behavioralScore,
        coding: report.codingScore,
      },
      recommendation: report.hiringRecommendation,
      recommendationReason: report.recommendationReason,
      summary: report.summary,
      strengths: (details.strengths ?? []).map((s) => s.point),
      weaknesses: (details.weaknesses ?? []).map((s) => s.point),
      reportUrl: `${appUrl}/reports/${report.id}`,
    };
  }

  /**
   * Pushes one report to an integration. Provider-specific auth differs, but
   * the body is identical so a generic webhook receiver works everywhere.
   */
  static async sync(integrationId: string, reportId: string, appUrl: string) {
    const [integration, report] = await Promise.all([
      prisma.atsIntegration.findUnique({ where: { id: integrationId } }),
      prisma.report.findUnique({
        where: { id: reportId },
        include: {
          sessionCandidate: { include: { candidate: true, interviewSession: true } },
        },
      }),
    ]);

    if (!integration) throw new Error('Integration not found');
    if (!integration.enabled) throw new Error('Integration is disabled');
    if (!report) throw new Error('Report not found');
    if (!integration.webhookUrl) throw new Error('Integration has no webhook URL configured');

    const payload = this.buildPayload(report, appUrl);

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (integration.apiKey) {
      // Greenhouse expects Basic; the rest take a bearer token.
      headers.Authorization =
        integration.provider === 'GREENHOUSE'
          ? `Basic ${Buffer.from(`${integration.apiKey}:`).toString('base64')}`
          : `Bearer ${integration.apiKey}`;
    }

    let success = false;
    let responseStatus: number | null = null;
    let message = '';

    try {
      const res = await fetch(integration.webhookUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });
      responseStatus = res.status;
      success = res.ok;
      if (!res.ok) message = (await res.text()).slice(0, 500);
    } catch (err) {
      message = (err as Error).message.slice(0, 500);
    }

    await prisma.atsSyncLog.create({
      data: { atsIntegrationId: integration.id, reportId, success, responseStatus, message: message || null },
    });

    if (!success) throw new Error(`ATS sync failed: ${message || `HTTP ${responseStatus}`}`);
    return { success, responseStatus };
  }

  /** Fans a completed report out to every enabled integration for the owner. */
  static async syncAll(userId: string, reportId: string, appUrl: string) {
    const integrations = await prisma.atsIntegration.findMany({
      where: { userId, enabled: true, webhookUrl: { not: null } },
    });

    const results = await Promise.allSettled(
      integrations.map((i) => this.sync(i.id, reportId, appUrl)),
    );

    return results.map((r, i) => ({
      integration: integrations[i]?.name ?? 'unknown',
      ok: r.status === 'fulfilled',
      error: r.status === 'rejected' ? String(r.reason) : null,
    }));
  }

  static async logs(userId: string, integrationId: string) {
    const integration = await prisma.atsIntegration.findFirst({ where: { id: integrationId, userId } });
    if (!integration) throw new Error('Integration not found');

    return prisma.atsSyncLog.findMany({
      where: { atsIntegrationId: integrationId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }
}
