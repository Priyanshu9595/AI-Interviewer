import type { Page } from 'playwright';
import { BotError, type MeetingPlatform, type ParsedMeetingLink } from '../errors';

/**
 * What every meeting platform has to provide.
 *
 * The three web clients differ in almost every detail — Zoom hides behind a
 * "launch the app" page, Teams renders its pre-join in an iframe, Meet asks to
 * be let in — but the shape of the problem is identical: open a link, turn the
 * camera off, turn the microphone on, ask to join, wait to be admitted, then
 * watch who else is in the room.
 *
 * That shape is this interface. Everything above it — the audio bridge, the
 * interview engine, the scheduler, the dashboard — is written once and works
 * for all three.
 */

export type JoinStage = 'OPENING_MEETING' | 'PRE_JOIN' | 'WAITING_FOR_ADMISSION' | 'JOINED';

export interface PlatformJoinOptions {
  link: ParsedMeetingLink;
  /** Shown to the candidate in the participant list. */
  displayName: string;
  /** How long to sit in the lobby before giving up. */
  admissionTimeoutMs: number;
  signal?: AbortSignal;
  onProgress: (stage: JoinStage, detail: string) => void;
}

/** One reading of the meeting's live state. */
export interface MeetingObservation {
  inCall: boolean;
  /**
   * Head-count including the bot. Zero means "could not be read", which is not
   * the same as an empty meeting and must never be treated as one — a bot that
   * miscounts to zero would end an interview that is in progress.
   */
  participants: number;
  /**
   * Someone is knocking but has not been let in yet.
   *
   * Kept separate from the head-count because it changes what a timeout means:
   * a candidate visibly waiting to be admitted has not failed to turn up, they
   * have failed to be admitted, and telling the recruiter the wrong one of
   * those wastes their time chasing the wrong person.
   */
  waitingRoomOccupied: boolean;
  ended: boolean;
  endReason: 'ENDED' | 'REMOVED' | null;
}

export interface PlatformDriver {
  readonly platform: MeetingPlatform;
  readonly label: string;

  /**
   * Whether joining needs a signed-in browser profile.
   *
   * Google Meet effectively does: an anonymous participant is refused outright
   * by many meetings, and knocking is unreliable. Zoom and Teams both support
   * joining as a named guest, so they run on a throwaway profile unless the
   * operator signs them in for meetings that require an account.
   */
  readonly requiresSignIn: boolean;

  /** Recognises a link as belonging to this platform. Cheap, no network. */
  matches(input: string): boolean;

  /** Validates and canonicalises. Throws BotError('INVALID_MEETING_URL'). */
  parse(input: string): ParsedMeetingLink;

  /** Navigation through to being inside the call. Throws BotError on failure. */
  join(page: Page, opts: PlatformJoinOptions): Promise<void>;

  /** Reads the live state, for the meeting monitor. Must never throw. */
  observe(page: Page): Promise<MeetingObservation>;

  /**
   * Lets waiting participants in, returning how many were admitted.
   *
   * The recruiter usually creates the meeting from the same account the bot is
   * signed in as, which makes the bot the host — and a host who never presses
   * Admit leaves the candidate in the waiting room for the whole interview,
   * with the transcript recording nothing but silence.
   *
   * Called on every monitor tick, so it must be cheap and must never throw.
   */
  admitWaiting(page: Page): Promise<number>;

  /**
   * Posts a line into the meeting chat. Returns false if the chat could not be
   * opened or the box could not be found.
   *
   * Used to hand the candidate the coding-exercise link. Best effort by design:
   * chat panels are the most volatile part of every one of these interfaces,
   * and the same link is emailed with the invitation, so a failure here costs
   * convenience rather than the round.
   */
  sendChat(page: Page, text: string): Promise<boolean>;

  /**
   * Starts sharing the tab named by SHARE_TAB_TITLE, so the candidate's code is
   * on screen for everyone in the meeting.
   *
   * Best effort, and deliberately so. The share picker is browser chrome rather
   * than page content, so it is steered by a command-line flag rather than
   * clicked; combined with three different "Present" menus, this is the least
   * dependable thing the bot does. When it fails the coding round still works —
   * the candidate has the editor, the interviewer still gets the submission —
   * so the interview must never be failed over it.
   */
  presentTab(page: Page): Promise<boolean>;

  /** Stops sharing. Never throws. */
  stopPresenting(page: Page): Promise<void>;

  /** Leaves politely, so the candidate sees the interviewer go. */
  leave(page: Page): Promise<void>;
}

/**
 * Throws if the interview has been stopped from the dashboard.
 *
 * Called between every step of a join, because a join can sit in a lobby for
 * ten minutes and a recruiter who pressed Stop should not have to wait it out.
 */
export function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new BotError('STOPPED_BY_RECRUITER');
}
