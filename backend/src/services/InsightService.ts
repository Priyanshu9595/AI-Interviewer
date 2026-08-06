import { InsightType } from '@prisma/client';
import { prisma } from '../lib/prisma';

export interface Insight {
  type: InsightType;
  message: string;
  severity: number;
  meta?: Record<string, unknown>;
}

const FILLERS = /\b(um+|uh+|er+|hmm+|like|you know|basically|actually|literally|i mean|sort of|kind of)\b/gi;
const HEDGES = /\b(maybe|i think|i guess|probably|not sure|might be|possibly|i believe|somewhat)\b/gi;
const UNSURE = /\b(i don'?t know|no idea|can'?t remember|not familiar|never used|never done)\b/i;

/**
 * Derives real-time signals from a single answer. Everything here is
 * rule-based and instant — the interview loop cannot wait on an LLM call to
 * decide whether the candidate hesitated.
 */
export function analyseAnswer(args: {
  text: string;
  latencyMs?: number | null;
  durationMs?: number | null;
  confidence?: number | null;
  answerQuality?: number;
}): Insight[] {
  const insights: Insight[] = [];
  const text = args.text.trim();
  const words = text.split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  // Hesitation before speaking at all.
  if (args.latencyMs != null) {
    if (args.latencyMs > 8000) {
      insights.push({
        type: 'LONG_PAUSE',
        message: `Paused ${(args.latencyMs / 1000).toFixed(1)}s before answering.`,
        severity: Math.min(1, args.latencyMs / 15000),
        meta: { latencyMs: args.latencyMs },
      });
    } else if (args.latencyMs > 4000) {
      insights.push({
        type: 'HESITATION',
        message: `Hesitated ${(args.latencyMs / 1000).toFixed(1)}s before answering.`,
        severity: 0.4,
        meta: { latencyMs: args.latencyMs },
      });
    }
  }

  // Filler density.
  const fillerCount = (text.match(FILLERS) ?? []).length;
  const fillerRatio = wordCount > 0 ? fillerCount / wordCount : 0;
  if (wordCount >= 15 && fillerRatio > 0.08) {
    insights.push({
      type: 'FILLER_HEAVY',
      message: `${fillerCount} filler words in ${wordCount} (${Math.round(fillerRatio * 100)}%).`,
      severity: Math.min(1, fillerRatio * 6),
      meta: { fillerCount, wordCount, fillerRatio },
    });
  }

  // Hedging and explicit uncertainty.
  const hedgeCount = (text.match(HEDGES) ?? []).length;
  if (UNSURE.test(text)) {
    insights.push({
      type: 'LOW_CONFIDENCE',
      message: 'Explicitly said they did not know.',
      severity: 0.7,
      meta: { reason: 'explicit-unknown' },
    });
  } else if (wordCount >= 15 && hedgeCount >= 3) {
    insights.push({
      type: 'LOW_CONFIDENCE',
      message: `Hedged ${hedgeCount} times in this answer.`,
      severity: Math.min(1, hedgeCount / 6),
      meta: { hedgeCount },
    });
  }

  // Too little to assess.
  if (wordCount > 0 && wordCount < 6) {
    insights.push({
      type: 'UNCLEAR_RESPONSE',
      message: `Answer was only ${wordCount} words.`,
      severity: 0.6,
      meta: { wordCount },
    });
  }

  // Poor ASR confidence usually means mumbling or a bad mic.
  if (args.confidence != null && args.confidence < 0.55 && wordCount > 3) {
    insights.push({
      type: 'UNCLEAR_RESPONSE',
      message: `Speech was hard to make out (recognition confidence ${Math.round(args.confidence * 100)}%).`,
      severity: 1 - args.confidence,
      meta: { confidence: args.confidence },
    });
  }

  // Speaking pace, when we know how long they spoke.
  if (args.durationMs && args.durationMs > 3000 && wordCount > 10) {
    const wpm = wordCount / (args.durationMs / 60_000);
    if (wpm > 190) {
      insights.push({
        type: 'HESITATION',
        message: `Speaking very fast (${Math.round(wpm)} words per minute).`,
        severity: 0.4,
        meta: { wpm },
      });
    } else if (wpm < 85) {
      insights.push({
        type: 'LOW_CONFIDENCE',
        message: `Speaking slowly (${Math.round(wpm)} words per minute).`,
        severity: 0.4,
        meta: { wpm },
      });
    }
  }

  // A strong answer is substantial, fluent and not hedged.
  if (
    args.answerQuality != null &&
    args.answerQuality >= 0.75 &&
    wordCount >= 40 &&
    fillerRatio < 0.05 &&
    hedgeCount <= 1
  ) {
    insights.push({
      type: 'STRONG_ANSWER',
      message: 'Detailed, fluent and confident answer.',
      severity: args.answerQuality,
      meta: { wordCount, answerQuality: args.answerQuality },
    });
  } else if (args.answerQuality != null && args.answerQuality < 0.3 && wordCount >= 10) {
    insights.push({
      type: 'OFF_TOPIC',
      message: 'Answer did not address the question.',
      severity: 1 - args.answerQuality,
      meta: { answerQuality: args.answerQuality },
    });
  }

  return insights;
}

export class InsightService {
  static async record(sessionCandidateId: string, insights: Insight[]) {
    if (!insights.length) return [];

    await prisma.realtimeInsight.createMany({
      data: insights.map((i) => ({
        sessionCandidateId,
        type: i.type,
        message: i.message,
        severity: Math.max(0, Math.min(1, i.severity)),
        meta: (i.meta ?? {}) as object,
      })),
    });

    return insights;
  }

  static async list(sessionCandidateId: string) {
    return prisma.realtimeInsight.findMany({
      where: { sessionCandidateId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Aggregates insights into counts the report and live panel both use. */
  static async summarise(sessionCandidateId: string) {
    const rows = await this.list(sessionCandidateId);
    const counts: Record<string, number> = {};
    let severitySum = 0;

    for (const row of rows) {
      counts[row.type] = (counts[row.type] ?? 0) + 1;
      if (row.type !== 'STRONG_ANSWER' && row.type !== 'HIGH_CONFIDENCE') {
        severitySum += row.severity;
      }
    }

    const positives = (counts.STRONG_ANSWER ?? 0) + (counts.HIGH_CONFIDENCE ?? 0);
    const negatives = rows.length - positives;

    return {
      total: rows.length,
      counts,
      positives,
      negatives,
      /** 0..10 composure score: penalises negative signals, rewards strong answers. */
      composure: Math.max(0, Math.min(10, 10 - severitySum * 1.2 + positives * 0.8)),
    };
  }
}
