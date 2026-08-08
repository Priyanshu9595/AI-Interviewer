/**
 * The vocabulary of an AI interview that runs inside a Google Meet call.
 *
 * The status list is the bot's own state machine, surfaced verbatim. Recruiters
 * watching a live interview need to tell "nobody has let the bot in yet" apart
 * from "the bot is in and waiting for the candidate" — collapsing those into
 * one "connecting" state would hide the only two things they can act on.
 */

export type MeetBotStatus =
  | 'SCHEDULED'
  | 'STARTING'
  | 'OPENING_MEETING'
  | 'PRE_JOIN'
  | 'WAITING_FOR_ADMISSION'
  | 'JOINED'
  | 'WAITING_FOR_CANDIDATE'
  | 'INTRODUCTION'
  | 'QUESTIONING'
  | 'FOLLOW_UP'
  | 'FINAL_QUESTION'
  | 'ENDING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type MeetingPlatform = 'GOOGLE_MEET' | 'ZOOM' | 'MS_TEAMS';

export interface MeetInterview {
  id: string;
  candidateName: string;
  candidateEmail: string;
  jobTitle: string;
  jobDescription: string;
  requiredSkills: string[];
  durationMinutes: number;
  scheduledAt: string;
  meetLink: string | null;
  platform: MeetingPlatform;
  platformLabel: string;
  /** Whether this platform needs the bot signed in, for the setup hint. */
  requiresSignIn: boolean;

  status: MeetBotStatus;
  statusDetail: string | null;
  errorCode: string | null;
  errorMessage: string | null;

  joinAt: string | null;
  startedAt: string | null;
  joinedAt: string | null;
  endedAt: string | null;
  attempts: number;

  candidateStatus: string;
  live: boolean;
  hasReport: boolean;
  evaluation: EvaluationState;
  sessionId: string;
  codingEnabled: boolean;
  /** Where the candidate writes their code, when there is a coding round. */
  codingUrl: string | null;
  /**
   * Whether that page is actually served. Null when there is no coding round.
   * False means the candidate would get a 404 — APP_URL points at a frontend
   * that does not have the page.
   */
  codingUrlReachable?: boolean | null;
}

export type EvaluationStateName =
  | 'READY'
  | 'PENDING'
  | 'RETRYING'
  | 'FAILED'
  | 'NO_TRANSCRIPT'
  | 'NOT_INTERVIEWED'
  | 'NOT_SCORED_INCOMPLETE';

export interface EvaluationState {
  state: EvaluationStateName;
  /** Plain-English reason, written for the recruiter. */
  explanation: string;
  reportId: string | null;
  attempts: number;
  /** The provider's own message, when it failed. */
  error: string | null;
  nextRetryAt: string | null;
  transcriptTurns: number;
}

const EVALUATION_TONE: Record<EvaluationStateName, 'success' | 'info' | 'warning' | 'danger' | 'neutral'> = {
  READY: 'success',
  PENDING: 'info',
  RETRYING: 'warning',
  FAILED: 'danger',
  NO_TRANSCRIPT: 'danger',
  NOT_INTERVIEWED: 'neutral',
  NOT_SCORED_INCOMPLETE: 'warning',
};

const EVALUATION_LABEL: Record<EvaluationStateName, string> = {
  READY: 'Report ready',
  PENDING: 'Writing the report',
  RETRYING: 'Retrying',
  FAILED: 'Report failed',
  NO_TRANSCRIPT: 'Nothing to score',
  NOT_INTERVIEWED: 'Not interviewed yet',
  NOT_SCORED_INCOMPLETE: 'Not scored',
};

export const evaluationTone = (state: EvaluationStateName) => EVALUATION_TONE[state] ?? 'neutral';
export const evaluationLabel = (state: EvaluationStateName) => EVALUATION_LABEL[state] ?? state;

/** Whether a manual retry would do anything. */
export const canRetryReport = (state: EvaluationStateName) =>
  state === 'FAILED' || state === 'RETRYING' || state === 'PENDING';

export interface TranscriptMessage {
  id: string;
  speaker: 'AI' | 'CANDIDATE' | 'SYSTEM';
  message: string;
  timestamp: string;
  round: string | null;
  questionNumber: number | null;
}

type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

interface StatusMeta {
  label: string;
  tone: Tone;
  /** Whether a bot is actively working on this interview right now. */
  live: boolean;
}

export const MEET_STATUS: Record<MeetBotStatus, StatusMeta> = {
  SCHEDULED: { label: 'Scheduled', tone: 'info', live: false },
  STARTING: { label: 'Starting', tone: 'warning', live: true },
  OPENING_MEETING: { label: 'Opening meeting', tone: 'warning', live: true },
  PRE_JOIN: { label: 'Joining', tone: 'warning', live: true },
  WAITING_FOR_ADMISSION: { label: 'Waiting for admission', tone: 'warning', live: true },
  JOINED: { label: 'Joined', tone: 'primary', live: true },
  WAITING_FOR_CANDIDATE: { label: 'Waiting for candidate', tone: 'warning', live: true },
  INTRODUCTION: { label: 'Introduction', tone: 'primary', live: true },
  QUESTIONING: { label: 'Interview running', tone: 'primary', live: true },
  FOLLOW_UP: { label: 'Follow-up question', tone: 'primary', live: true },
  FINAL_QUESTION: { label: 'Final question', tone: 'primary', live: true },
  ENDING: { label: 'Wrapping up', tone: 'primary', live: true },
  COMPLETED: { label: 'Interview completed', tone: 'success', live: false },
  FAILED: { label: 'Failed', tone: 'danger', live: false },
  CANCELLED: { label: 'Cancelled', tone: 'neutral', live: false },
};

export const statusMeta = (status: MeetBotStatus): StatusMeta =>
  MEET_STATUS[status] ?? { label: status, tone: 'neutral', live: false };

/** The stage a recruiter would call "the interview is actually happening". */
export const isInterviewing = (status: MeetBotStatus) =>
  ['INTRODUCTION', 'QUESTIONING', 'FOLLOW_UP', 'FINAL_QUESTION'].includes(status);

export const canStart = (status: MeetBotStatus) =>
  ['SCHEDULED', 'FAILED', 'CANCELLED'].includes(status);

export const canStop = (status: MeetBotStatus) => statusMeta(status).live;

// ---------------------------------------------------------------------------
// Link validation
//
// Mirrors the server's parsers so a mistyped link is caught while the recruiter
// still has the form open, rather than at the scheduled time with nobody
// watching. The server validates again — this is for speed, not for trust.
// ---------------------------------------------------------------------------

export const PLATFORM_LABEL: Record<MeetingPlatform, string> = {
  GOOGLE_MEET: 'Google Meet',
  ZOOM: 'Zoom',
  MS_TEAMS: 'Microsoft Teams',
};

/** Meeting codes are three letters, four letters, three letters. */
const GOOGLE_MEET_URL = /^(https?:\/\/)?meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?(\?.*)?$/i;
/** Zoom ids are 9–11 digits, under /j/, /s/ or the web client's /wc/. */
const ZOOM_URL = /^(https?:\/\/)?([\w-]+\.)*zoom\.(us|com)\/(j|s|w|wc)\/(join\/)?\d{9,11}/i;
/** Teams uses a long meetup-join path, or a short numeric one for personal accounts. */
const TEAMS_URL = /^(https?:\/\/)?teams\.(microsoft|live)\.com\/(.*\/)?(l\/meetup-join\/|meet\/\d)/i;

/** Which platform a link belongs to, or null if none recognise it. */
export function detectPlatform(value: string): MeetingPlatform | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/(^|\/\/)meet\.google\.com\//i.test(trimmed)) return 'GOOGLE_MEET';
  if (/(^|\/\/|\.)zoom\.(us|com)\//i.test(trimmed)) return 'ZOOM';
  if (/(^|\/\/)teams\.(microsoft|live)\.com\//i.test(trimmed)) return 'MS_TEAMS';
  return null;
}

/** Null when the link is usable, otherwise the reason it is not. */
export function validateMeetingLink(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return 'Paste the meeting link for this interview.';

  switch (detectPlatform(trimmed)) {
    case 'GOOGLE_MEET':
      return GOOGLE_MEET_URL.test(trimmed)
        ? null
        : 'That Google Meet link looks incomplete. It should look like https://meet.google.com/abc-defg-hij';

    case 'ZOOM':
      if (!ZOOM_URL.test(trimmed)) {
        return 'That Zoom link looks incomplete. It should look like https://us05web.zoom.us/j/85512345678?pwd=…';
      }
      // Without the passcode the bot reaches a prompt it cannot answer.
      return /[?&]pwd=/i.test(trimmed)
        ? null
        : 'This Zoom link has no passcode in it. Copy the full invitation link, which normally ends in ?pwd=…';

    case 'MS_TEAMS':
      return TEAMS_URL.test(trimmed)
        ? null
        : 'That Teams link looks incomplete. Use the full "Join the meeting now" link from the invitation.';

    default:
      return 'That does not look like a meeting link. Paste a Google Meet, Zoom or Microsoft Teams link.';
  }
}
