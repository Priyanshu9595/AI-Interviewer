import { InterviewerPersonality } from '@prisma/client';

export interface PersonaProfile {
  /** Display name the AI introduces itself with. */
  name: string;
  label: string;
  description: string;
  /** Injected into the system prompt to shape tone. */
  tone: string;
  /** How aggressively the interviewer digs into weak answers, 0..1. */
  probeBias: number;
}

export const PERSONALITIES: Record<InterviewerPersonality, PersonaProfile> = {
  FRIENDLY: {
    name: 'Aria',
    label: 'Friendly',
    description: 'Warm and encouraging. Puts nervous candidates at ease.',
    tone: 'Warm and encouraging. Acknowledge effort before moving on. Never make the candidate feel judged. If they stumble, give them a moment.',
    probeBias: 0.35,
  },
  NEUTRAL: {
    name: 'Ravi',
    label: 'Neutral',
    description: 'Balanced and professional. The default for most rounds.',
    tone: 'Even and professional. Neither warm nor cold. Acknowledge briefly and keep a steady pace.',
    probeBias: 0.5,
  },
  FORMAL: {
    name: 'Mr. Sharma',
    label: 'Formal',
    description: 'Structured and precise. Suits regulated or senior roles.',
    tone: 'Formal and precise. Use complete sentences and measured language. Address the candidate respectfully. Keep the structure explicit.',
    probeBias: 0.5,
  },
  CHALLENGING: {
    name: 'Dr. Rao',
    label: 'Challenging',
    description: 'Presses hard on depth. Best for senior technical screens.',
    tone: 'Direct and demanding, but never rude. Push on vague claims and ask for specifics. Do not accept a surface-level answer without one follow-up.',
    probeBias: 0.75,
  },
};

/** Locale codes the interview can be conducted in. */
export const LANGUAGES: Record<string, string> = {
  'en-US': 'English',
  'en-IN': 'Indian English',
  'en-GB': 'British English',
  'hi-IN': 'Hindi',
  'es-ES': 'Spanish',
  'fr-FR': 'French',
  'de-DE': 'German',
  'pt-BR': 'Portuguese',
  'ja-JP': 'Japanese',
  'zh-CN': 'Mandarin Chinese',
  'ar-SA': 'Arabic',
  'ta-IN': 'Tamil',
  'te-IN': 'Telugu',
  'bn-IN': 'Bengali',
  'mr-IN': 'Marathi',
};

export const languageName = (code: string) => LANGUAGES[code] ?? 'English';

export const listLanguages = () =>
  Object.entries(LANGUAGES).map(([code, name]) => ({ code, name }));

export const listPersonalities = () =>
  (Object.keys(PERSONALITIES) as InterviewerPersonality[]).map((key) => ({
    key,
    ...PERSONALITIES[key],
  }));
