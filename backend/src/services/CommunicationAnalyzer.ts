import { Speaker } from '@prisma/client';

export interface SpeechSignals {
  totalWords: number;
  answerCount: number;
  avgWordsPerAnswer: number;
  avgLatencyMs: number;
  maxLatencyMs: number;
  longPauses: number;
  fillerCount: number;
  fillerRatio: number;
  hedgeCount: number;
  hedgeRatio: number;
  avgWordsPerMinute: number;
  vocabularyRichness: number;
  avgAsrConfidence: number | null;
  sentenceCount: number;
  avgSentenceLength: number;
  repetitionRatio: number;
}

export interface CommunicationScores {
  fluency: number;
  confidence: number;
  clarity: number;
  grammar: number;
  vocabulary: number;
  pace: number;
  overall: number;
  notes: string[];
}

const FILLERS = /\b(um+|uh+|er+|hmm+|like|you know|basically|actually|literally|i mean|sort of|kind of|right\?)\b/gi;
const HEDGES = /\b(maybe|i think|i guess|probably|not sure|might be|possibly|i believe|somewhat|perhaps)\b/gi;
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of', 'in',
  'on', 'at', 'for', 'with', 'it', 'this', 'that', 'i', 'we', 'you', 'they', 'my', 'so', 'as', 'if',
  'do', 'did', 'have', 'has', 'had', 'not', 'what', 'when', 'which', 'there', 'then', 'them', 'me',
]);

/** Maps a raw measurement onto 0..10 using a piecewise-linear ideal band. */
function scoreBand(value: number, poor: number, ideal: number, idealMax = ideal, tooHigh = Infinity): number {
  if (value >= ideal && value <= idealMax) return 10;

  if (value < ideal) {
    if (value <= poor) return 0;
    return ((value - poor) / (ideal - poor)) * 10;
  }

  if (tooHigh === Infinity) return 10;
  if (value >= tooHigh) return 0;
  return ((tooHigh - value) / (tooHigh - idealMax)) * 10;
}

const clamp = (n: number) => Math.max(0, Math.min(10, Math.round(n * 10) / 10));

export type AnalysableTurn = {
  speaker: Speaker;
  text: string;
  latencyMs: number | null;
  durationMs: number | null;
  confidence: number | null;
  wordsPerMinute: number | null;
};

/**
 * Derives objective speech measurements from the candidate's turns. These are
 * computed, not guessed — the LLM later reads them but is told not to
 * re-estimate them.
 */
export function extractSignals(turns: AnalysableTurn[]): SpeechSignals {
  const answers = turns.filter((t) => t.speaker === 'CANDIDATE' && t.text.trim().length > 0);

  let totalWords = 0;
  let fillerCount = 0;
  let hedgeCount = 0;
  let latencySum = 0;
  let latencyCount = 0;
  let maxLatencyMs = 0;
  let longPauses = 0;
  let wpmSum = 0;
  let wpmCount = 0;
  let confSum = 0;
  let confCount = 0;
  let sentenceCount = 0;

  const vocabulary = new Map<string, number>();

  for (const turn of answers) {
    const text = turn.text.trim();
    const words = text.split(/\s+/).filter(Boolean);
    totalWords += words.length;

    fillerCount += (text.match(FILLERS) ?? []).length;
    hedgeCount += (text.match(HEDGES) ?? []).length;

    sentenceCount += (text.match(/[.!?]+/g) ?? []).length || 1;

    for (const word of words) {
      const key = word.toLowerCase().replace(/[^a-z']/g, '');
      if (key.length > 2 && !STOP_WORDS.has(key)) {
        vocabulary.set(key, (vocabulary.get(key) ?? 0) + 1);
      }
    }

    if (turn.latencyMs != null) {
      latencySum += turn.latencyMs;
      latencyCount++;
      maxLatencyMs = Math.max(maxLatencyMs, turn.latencyMs);
      if (turn.latencyMs > 5000) longPauses++;
    }

    if (turn.wordsPerMinute != null && turn.wordsPerMinute > 0) {
      wpmSum += turn.wordsPerMinute;
      wpmCount++;
    }

    if (turn.confidence != null) {
      confSum += turn.confidence;
      confCount++;
    }
  }

  const uniqueWords = vocabulary.size;
  const contentWords = [...vocabulary.values()].reduce((a, b) => a + b, 0);

  // How often the candidate leans on the same few words.
  const repeated = [...vocabulary.values()].filter((c) => c > 3).reduce((a, b) => a + b, 0);

  return {
    totalWords,
    answerCount: answers.length,
    avgWordsPerAnswer: answers.length ? Math.round(totalWords / answers.length) : 0,
    avgLatencyMs: latencyCount ? Math.round(latencySum / latencyCount) : 0,
    maxLatencyMs,
    longPauses,
    fillerCount,
    fillerRatio: totalWords ? fillerCount / totalWords : 0,
    hedgeCount,
    hedgeRatio: totalWords ? hedgeCount / totalWords : 0,
    avgWordsPerMinute: wpmCount ? Math.round(wpmSum / wpmCount) : 0,
    vocabularyRichness: contentWords ? uniqueWords / contentWords : 0,
    avgAsrConfidence: confCount ? confSum / confCount : null,
    sentenceCount,
    avgSentenceLength: sentenceCount ? Math.round(totalWords / sentenceCount) : 0,
    repetitionRatio: contentWords ? repeated / contentWords : 0,
  };
}

/**
 * Turns the measurements into 0..10 sub-scores. Deliberately rule-based so the
 * communication score is reproducible and defensible rather than an LLM's mood.
 */
export function scoreCommunication(s: SpeechSignals): CommunicationScores {
  const notes: string[] = [];

  if (s.answerCount === 0) {
    return {
      fluency: 0, confidence: 0, clarity: 0, grammar: 0, vocabulary: 0, pace: 0, overall: 0,
      notes: ['No spoken answers were captured.'],
    };
  }

  // Fluency: few fillers, long enough answers, no stalling.
  const fillerPenalty = Math.min(10, s.fillerRatio * 100);
  const lengthScore = scoreBand(s.avgWordsPerAnswer, 5, 45, 160, 400);
  const fluency = clamp(lengthScore * 0.5 + (10 - fillerPenalty) * 0.5);
  if (s.fillerRatio > 0.06) notes.push(`Filler words made up ${(s.fillerRatio * 100).toFixed(1)}% of speech.`);

  // Confidence: quick starts, few long pauses, little hedging.
  const latencyScore = scoreBand(-s.avgLatencyMs, -9000, -1500, 0, Infinity);
  const pausePenalty = Math.min(10, (s.longPauses / s.answerCount) * 18);
  const hedgePenalty = Math.min(10, s.hedgeRatio * 130);
  const confidence = clamp(latencyScore * 0.4 + (10 - pausePenalty) * 0.3 + (10 - hedgePenalty) * 0.3);
  if (s.longPauses > 0) notes.push(`${s.longPauses} pause(s) over 5 seconds before answering.`);
  if (s.avgLatencyMs > 4000) notes.push(`Averaged ${(s.avgLatencyMs / 1000).toFixed(1)}s before starting to answer.`);

  // Clarity: recognisable speech, digestible sentences, not repetitive.
  const asrScore = s.avgAsrConfidence != null ? s.avgAsrConfidence * 10 : 7;
  const sentenceScore = scoreBand(s.avgSentenceLength, 3, 12, 25, 55);
  const clarity = clamp(asrScore * 0.45 + sentenceScore * 0.35 + (10 - s.repetitionRatio * 25) * 0.2);
  if (s.avgAsrConfidence != null && s.avgAsrConfidence < 0.7) {
    notes.push(`Speech recognition confidence averaged ${(s.avgAsrConfidence * 100).toFixed(0)}%, suggesting unclear delivery or a poor microphone.`);
  }

  // Grammar: proxied by sentence structure regularity and filler-free phrasing.
  const grammar = clamp(sentenceScore * 0.5 + (10 - fillerPenalty * 0.6) * 0.5);

  // Vocabulary: lexical variety, penalised for leaning on the same words.
  const richness = scoreBand(s.vocabularyRichness, 0.15, 0.45, 0.85, 1.2);
  const vocabulary = clamp(richness * 0.75 + (10 - s.repetitionRatio * 20) * 0.25);
  if (s.vocabularyRichness < 0.3) notes.push('Vocabulary was fairly repetitive across answers.');

  // Pace: 110-165 wpm reads as comfortable conversational speech.
  const pace = s.avgWordsPerMinute > 0 ? clamp(scoreBand(s.avgWordsPerMinute, 50, 110, 165, 260)) : 6;
  if (s.avgWordsPerMinute > 180) notes.push(`Spoke quickly at ${s.avgWordsPerMinute} words per minute.`);
  if (s.avgWordsPerMinute > 0 && s.avgWordsPerMinute < 95) notes.push(`Spoke slowly at ${s.avgWordsPerMinute} words per minute.`);

  const overall = clamp(
    fluency * 0.22 + confidence * 0.22 + clarity * 0.2 + grammar * 0.14 + vocabulary * 0.12 + pace * 0.1,
  );

  if (!notes.length) notes.push('Communication was steady with no notable issues.');

  return { fluency, confidence, clarity, grammar, vocabulary, pace, overall, notes };
}
