import { Speaker } from '@prisma/client';
import { prisma } from '../lib/prisma';

export interface TurnInput {
  speaker: Speaker;
  text: string;
  questionId?: string | null;
  round?: string | null;
  latencyMs?: number | null;
  durationMs?: number | null;
  confidence?: number | null;
}

export class TranscriptService {
  /** Returns the transcript for an interview, creating it on first use. */
  static async ensure(sessionCandidateId: string) {
    const existing = await prisma.interviewTranscript.findUnique({ where: { sessionCandidateId } });
    if (existing) return existing;

    try {
      return await prisma.interviewTranscript.create({ data: { sessionCandidateId } });
    } catch {
      // Lost a race with a concurrent turn; the row now exists.
      const row = await prisma.interviewTranscript.findUnique({ where: { sessionCandidateId } });
      if (!row) throw new Error('Could not create transcript');
      return row;
    }
  }

  static async logTurn(sessionCandidateId: string, turn: TurnInput) {
    const transcript = await this.ensure(sessionCandidateId);

    // Speaking rate is only meaningful for the candidate and only when the
    // client measured how long they spoke.
    let wordsPerMinute: number | null = null;
    if (turn.speaker === 'CANDIDATE' && turn.durationMs && turn.durationMs > 1000) {
      const words = turn.text.trim().split(/\s+/).filter(Boolean).length;
      wordsPerMinute = Math.round((words / (turn.durationMs / 60_000)) * 10) / 10;
    }

    return prisma.transcriptTurn.create({
      data: {
        interviewTranscriptId: transcript.id,
        speaker: turn.speaker,
        text: turn.text,
        questionId: turn.questionId ?? null,
        round: turn.round ?? null,
        latencyMs: turn.latencyMs ?? null,
        durationMs: turn.durationMs ?? null,
        confidence: turn.confidence ?? null,
        wordsPerMinute,
      },
    });
  }

  static async getTurns(sessionCandidateId: string) {
    const transcript = await prisma.interviewTranscript.findUnique({
      where: { sessionCandidateId },
      include: { turns: { orderBy: { timestamp: 'asc' } } },
    });
    return transcript?.turns ?? [];
  }

  /** Renders the conversation as plain text for prompting and for export. */
  static format(turns: Array<{ speaker: Speaker; text: string }>): string {
    return turns
      .filter((t) => t.speaker !== 'SYSTEM')
      .map((t) => `${t.speaker === 'AI' ? 'INTERVIEWER' : 'CANDIDATE'}: ${t.text}`)
      .join('\n');
  }

  /** Pairs each AI question with the candidate's reply for the report. */
  static toQnA(turns: Array<{ speaker: Speaker; text: string; round: string | null }>) {
    const pairs: Array<{ question: string; answer: string; round: string | null }> = [];
    let pending: { question: string; round: string | null } | null = null;

    for (const turn of turns) {
      if (turn.speaker === 'AI') {
        pending = { question: turn.text, round: turn.round };
      } else if (turn.speaker === 'CANDIDATE' && pending) {
        pairs.push({ question: pending.question, answer: turn.text, round: pending.round });
        pending = null;
      }
    }
    return pairs;
  }
}
