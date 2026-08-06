import { prisma } from '../lib/prisma';

export interface FrameMetrics {
  /** Fraction of sampled frames in this window containing a face (0..1). */
  facePresence: number;
  /** Movement magnitude between frames (0..1). High values read as fidgeting. */
  motion: number;
  /** How centred and steady the face is (0..1). Proxy for sustained eye contact. */
  gazeStability: number;
  /** Optional expression label derived client-side. */
  expression?: string | null;
}

export interface VideoSummary {
  samples: number;
  avgFacePresence: number;
  avgMotion: number;
  avgGazeStability: number;
  avgConfidence: number;
  /** 0..10 for the report. */
  confidenceScore: number;
  engagementScore: number;
  dominantExpression: string;
  expressionBreakdown: Record<string, number>;
  observations: string[];
}

/**
 * Composite visual confidence for one sampled window.
 *
 * Weighting rationale: being on camera at all dominates; a steady, centred head
 * reads as engaged; excess movement reads as restless and is subtracted.
 */
export function computeFrameConfidence(m: FrameMetrics): number {
  const presence = Math.max(0, Math.min(1, m.facePresence));
  const stability = Math.max(0, Math.min(1, m.gazeStability));
  const motion = Math.max(0, Math.min(1, m.motion));

  // A little motion is natural; only sustained restlessness is penalised.
  const motionPenalty = motion > 0.45 ? (motion - 0.45) / 0.55 : 0;

  return Math.max(0, Math.min(1, presence * 0.45 + stability * 0.45 - motionPenalty * 0.25 + 0.05));
}

/** Coarse expression inference when the client does not supply a label. */
function inferExpression(m: FrameMetrics, confidence: number): string {
  if (m.facePresence < 0.35) return 'ABSENT';
  if (m.motion > 0.6) return 'RESTLESS';
  if (confidence > 0.72) return 'ENGAGED';
  if (m.gazeStability < 0.35) return 'DISTRACTED';
  if (confidence < 0.4) return 'TENSE';
  return 'NEUTRAL';
}

export class VideoAnalysisService {
  /**
   * Stores one sampled window. The browser does the frame maths and posts
   * aggregates only — no imagery ever leaves the candidate's machine.
   */
  static async record(sessionCandidateId: string, metrics: FrameMetrics) {
    const confidence = computeFrameConfidence(metrics);
    const expression = metrics.expression || inferExpression(metrics, confidence);

    return prisma.videoAnalysisFrame.create({
      data: {
        sessionCandidateId,
        facePresence: metrics.facePresence,
        motion: metrics.motion,
        gazeStability: metrics.gazeStability,
        expression,
        confidence,
      },
    });
  }

  static async recordBatch(sessionCandidateId: string, batch: FrameMetrics[]) {
    if (!batch.length) return 0;

    const rows = batch.map((m) => {
      const confidence = computeFrameConfidence(m);
      return {
        sessionCandidateId,
        facePresence: m.facePresence,
        motion: m.motion,
        gazeStability: m.gazeStability,
        expression: m.expression || inferExpression(m, confidence),
        confidence,
      };
    });

    const res = await prisma.videoAnalysisFrame.createMany({ data: rows });
    return res.count;
  }

  static async summarise(sessionCandidateId: string): Promise<VideoSummary | null> {
    const frames = await prisma.videoAnalysisFrame.findMany({
      where: { sessionCandidateId },
      orderBy: { capturedAt: 'asc' },
    });

    if (!frames.length) return null;

    const n = frames.length;
    const sum = frames.reduce(
      (acc, f) => ({
        presence: acc.presence + f.facePresence,
        motion: acc.motion + f.motion,
        gaze: acc.gaze + f.gazeStability,
        confidence: acc.confidence + f.confidence,
      }),
      { presence: 0, motion: 0, gaze: 0, confidence: 0 },
    );

    const expressionBreakdown: Record<string, number> = {};
    for (const f of frames) {
      const key = f.expression ?? 'NEUTRAL';
      expressionBreakdown[key] = (expressionBreakdown[key] ?? 0) + 1;
    }

    const dominantExpression =
      Object.entries(expressionBreakdown).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'NEUTRAL';

    const avgFacePresence = sum.presence / n;
    const avgMotion = sum.motion / n;
    const avgGazeStability = sum.gaze / n;
    const avgConfidence = sum.confidence / n;

    const observations: string[] = [];
    if (avgFacePresence < 0.6) {
      observations.push(`On camera for only ${Math.round(avgFacePresence * 100)}% of sampled moments.`);
    }
    if (avgGazeStability < 0.45) {
      observations.push('Frequently looked away from the camera.');
    } else if (avgGazeStability > 0.75) {
      observations.push('Held steady eye contact throughout.');
    }
    if (avgMotion > 0.55) {
      observations.push('Noticeably restless movement during the interview.');
    }
    if (dominantExpression === 'TENSE') {
      observations.push('Appeared tense for much of the session.');
    } else if (dominantExpression === 'ENGAGED') {
      observations.push('Appeared engaged and attentive.');
    }
    if (!observations.length) observations.push('Nothing unusual in on-camera presence.');

    return {
      samples: n,
      avgFacePresence: Math.round(avgFacePresence * 100) / 100,
      avgMotion: Math.round(avgMotion * 100) / 100,
      avgGazeStability: Math.round(avgGazeStability * 100) / 100,
      avgConfidence: Math.round(avgConfidence * 100) / 100,
      confidenceScore: Math.round(avgConfidence * 100) / 10,
      engagementScore: Math.round(((avgFacePresence * 0.5 + avgGazeStability * 0.5) * 100)) / 10,
      dominantExpression,
      expressionBreakdown,
      observations,
    };
  }

  /** Timeline for the report chart, bucketed so long interviews stay readable. */
  static async timeline(sessionCandidateId: string, buckets = 24) {
    const frames = await prisma.videoAnalysisFrame.findMany({
      where: { sessionCandidateId },
      orderBy: { capturedAt: 'asc' },
      select: { confidence: true, facePresence: true, motion: true, capturedAt: true },
    });

    if (frames.length <= buckets) {
      return frames.map((f, i) => ({
        t: i,
        confidence: Math.round(f.confidence * 100) / 100,
        presence: Math.round(f.facePresence * 100) / 100,
        motion: Math.round(f.motion * 100) / 100,
      }));
    }

    const size = Math.ceil(frames.length / buckets);
    const out: Array<{ t: number; confidence: number; presence: number; motion: number }> = [];

    for (let i = 0; i < frames.length; i += size) {
      const slice = frames.slice(i, i + size);
      out.push({
        t: out.length,
        confidence: Math.round((slice.reduce((a, f) => a + f.confidence, 0) / slice.length) * 100) / 100,
        presence: Math.round((slice.reduce((a, f) => a + f.facePresence, 0) / slice.length) * 100) / 100,
        motion: Math.round((slice.reduce((a, f) => a + f.motion, 0) / slice.length) * 100) / 100,
      });
    }

    return out;
  }
}
