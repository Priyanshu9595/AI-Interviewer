/**
 * Every way joining or running a meeting can fail, as a closed set.
 *
 * The code is stored on the run and shown to the recruiter, so it has to say
 * what actually went wrong and — where the recruiter can do something about it
 * — what to do next. `retryable` marks failures that a later attempt could
 * plausibly clear; a bad link or a locked-out bot account never will.
 */
export type BotErrorCode =
  | 'INVALID_MEETING_URL'
  | 'UNSUPPORTED_PLATFORM'
  | 'BOT_DISABLED'
  | 'BROWSER_LAUNCH_FAILED'
  | 'BROWSER_CRASHED'
  | 'SERVERLESS_HOST'
  | 'SIGN_IN_REQUIRED'
  | 'VERIFICATION_REQUIRED'
  | 'GUEST_JOIN_BLOCKED'
  | 'PASSCODE_REQUIRED'
  | 'MEETING_PAGE_TIMEOUT'
  | 'PRE_JOIN_NOT_FOUND'
  | 'JOIN_CONTROL_NOT_FOUND'
  | 'ADMISSION_DENIED'
  | 'ADMISSION_TIMEOUT'
  | 'MEETING_NOT_STARTED'
  | 'MEETING_ENDED'
  | 'REMOVED_FROM_MEETING'
  | 'CANDIDATE_NO_SHOW'
  | 'MICROPHONE_UNAVAILABLE'
  | 'AUDIO_BRIDGE_FAILED'
  | 'TTS_UNAVAILABLE'
  | 'SPEECH_TO_TEXT_UNAVAILABLE'
  | 'LLM_UNAVAILABLE'
  | 'NETWORK_FAILURE'
  | 'CAPACITY_REACHED'
  | 'ALREADY_RUNNING'
  | 'NOT_STARTABLE'
  | 'RUN_NOT_FOUND'
  | 'STOPPED_BY_RECRUITER'
  | 'UNKNOWN';

/** Whether a fresh attempt at the same run could reasonably succeed. */
const RETRYABLE: ReadonlySet<BotErrorCode> = new Set<BotErrorCode>([
  'BROWSER_LAUNCH_FAILED',
  'BROWSER_CRASHED',
  'MEETING_PAGE_TIMEOUT',
  'PRE_JOIN_NOT_FOUND',
  'JOIN_CONTROL_NOT_FOUND',
  'MEETING_NOT_STARTED',
  'AUDIO_BRIDGE_FAILED',
  'NETWORK_FAILURE',
  'CAPACITY_REACHED',
]);

/** What the recruiter is told, and what they can do about it. */
const GUIDANCE: Record<BotErrorCode, string> = {
  INVALID_MEETING_URL:
    'That is not a meeting link the AI interviewer recognises. Paste a Google Meet, Zoom or Microsoft Teams link.',
  UNSUPPORTED_PLATFORM: 'The AI interviewer can join Google Meet, Zoom and Microsoft Teams meetings only.',
  BOT_DISABLED: 'The meeting bot is switched off on this server (MEET_BOT_ENABLED).',
  BROWSER_LAUNCH_FAILED: 'The interviewer could not start its browser. Check the Playwright install on the server.',
  BROWSER_CRASHED: 'The interviewer’s browser stopped unexpectedly during the meeting.',
  SERVERLESS_HOST:
    'The meeting bot cannot run on a serverless host. It needs a long-running server with a persistent disk — the browser stays open for the whole interview, and the signed-in profile has to survive between runs. Deploy the backend to Railway, Render, Fly.io or a VPS. The frontend can stay where it is.',
  SIGN_IN_REQUIRED:
    'The bot account is signed out of this meeting platform. Run `npm run bot:login` on the server to sign in again.',
  VERIFICATION_REQUIRED:
    'The meeting platform asked the bot account to complete a security check. Sign in manually with `npm run bot:login` and clear it — the bot will not attempt it.',
  GUEST_JOIN_BLOCKED:
    'This meeting does not allow guests. Either enable anonymous or guest join for it, or sign the bot account in to an account that has been invited.',
  PASSCODE_REQUIRED:
    'This meeting needs a passcode and the link does not carry one. Copy the full invite link, which normally includes it.',
  MEETING_PAGE_TIMEOUT: 'The meeting page did not finish loading in time.',
  PRE_JOIN_NOT_FOUND:
    'The join screen never appeared, so the interviewer could not set up its camera and microphone.',
  JOIN_CONTROL_NOT_FOUND: 'The interviewer could not find a Join button on the meeting page.',
  ADMISSION_DENIED: 'The meeting host declined the interviewer’s request to join.',
  ADMISSION_TIMEOUT: 'Nobody admitted the interviewer from the waiting room in time.',
  MEETING_NOT_STARTED: 'The meeting has not started yet, so there was nothing to join.',
  MEETING_ENDED: 'The meeting ended before the interview finished.',
  REMOVED_FROM_MEETING: 'The interviewer was removed from the meeting.',
  CANDIDATE_NO_SHOW: 'The candidate never joined the meeting.',
  MICROPHONE_UNAVAILABLE: 'The meeting refused the interviewer’s microphone, so it had no voice.',
  AUDIO_BRIDGE_FAILED: 'The interviewer could not connect its audio to the meeting.',
  TTS_UNAVAILABLE: 'Speech synthesis is unavailable, so the interviewer had no voice.',
  SPEECH_TO_TEXT_UNAVAILABLE: 'Deepgram is unreachable, so the interviewer could not hear the candidate.',
  LLM_UNAVAILABLE: 'The language model is unavailable, so the interviewer could not hold a conversation.',
  NETWORK_FAILURE: 'The server lost its network connection during the meeting.',
  CAPACITY_REACHED: 'This server is already running the maximum number of concurrent meetings.',
  ALREADY_RUNNING: 'The AI interviewer is already running for this interview.',
  NOT_STARTABLE: 'This interview cannot be started from its current state.',
  RUN_NOT_FOUND: 'This interview has no meeting link attached, so there is nothing to join.',
  STOPPED_BY_RECRUITER: 'Stopped from the dashboard.',
  UNKNOWN: 'The interview failed for an unexpected reason.',
};

/**
 * A failure with a code the rest of the system can branch on.
 *
 * `message` stays human-readable because it is written to the run and rendered
 * verbatim in the recruiter dashboard; `detail` carries the raw cause for logs.
 * `override` replaces the stock wording when a platform can say something more
 * specific — "Run bot:login for Zoom" beats "the bot account is signed out".
 */
export class BotError extends Error {
  readonly code: BotErrorCode;
  readonly retryable: boolean;
  readonly detail?: string;

  constructor(code: BotErrorCode, detail?: string, override?: string) {
    super(override ?? GUIDANCE[code] ?? GUIDANCE.UNKNOWN);
    this.name = 'BotError';
    this.code = code;
    this.retryable = RETRYABLE.has(code);
    this.detail = detail;
  }
}

/**
 * Turns anything thrown inside the bot into a BotError.
 *
 * Playwright reports a lost page, a killed browser and a dead network in prose
 * rather than in codes, so the wording is matched here once instead of at every
 * call site.
 */
export function toBotError(err: unknown): BotError {
  if (err instanceof BotError) return err;

  const raw = err instanceof Error ? err.message : String(err);
  const text = raw.toLowerCase();

  if (text.includes('target page, context or browser has been closed') || text.includes('browser has been closed')) {
    return new BotError('BROWSER_CRASHED', raw);
  }
  if (
    text.includes('net::err_') ||
    text.includes('econnrefused') ||
    text.includes('enotfound') ||
    text.includes('getaddrinfo')
  ) {
    return new BotError('NETWORK_FAILURE', raw);
  }
  if (text.includes('timeout') && text.includes('exceeded')) {
    return new BotError('MEETING_PAGE_TIMEOUT', raw);
  }
  if (
    text.includes('executable doesn’t exist') ||
    text.includes("executable doesn't exist") ||
    text.includes('playwright install')
  ) {
    return new BotError('BROWSER_LAUNCH_FAILED', raw);
  }

  return new BotError('UNKNOWN', raw);
}

// ---------------------------------------------------------------------------
// Platforms
// ---------------------------------------------------------------------------

export type MeetingPlatform = 'GOOGLE_MEET' | 'ZOOM' | 'MS_TEAMS';

export const PLATFORM_LABEL: Record<MeetingPlatform, string> = {
  GOOGLE_MEET: 'Google Meet',
  ZOOM: 'Zoom',
  MS_TEAMS: 'Microsoft Teams',
};

export interface ParsedMeetingLink {
  platform: MeetingPlatform;
  /** Canonical form shown to the recruiter and emailed to the candidate. */
  displayUrl: string;
  /**
   * What the bot actually navigates to. Usually the same, but Zoom's normal
   * link opens a "launch the desktop app" page, so the bot goes to the web
   * client directly instead.
   */
  joinUrl: string;
  /** Meeting code or numeric id, for logs and error messages. */
  id: string;
  /** Passcode carried in the link, where the platform puts one there. */
  passcode?: string;
}
