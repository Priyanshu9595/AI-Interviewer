import { CandidateStatus, SessionStatus } from '@prisma/client';
import { env } from '../lib/env';

export type GateVerdict =
  | 'OPEN'
  | 'TOO_EARLY'
  | 'EXPIRED'
  | 'ALREADY_COMPLETED'
  | 'MARKED_ABSENT'
  | 'CANCELLED';

export interface GateResult {
  canJoin: boolean;
  verdict: GateVerdict;
  /** Candidate-facing explanation. Null when the room is open. */
  reason: string | null;
  /** When the room opens — the scheduled time itself. */
  opensAt: Date;
  /** After this moment an unused link stops working. */
  expiresAt: Date;
}

export interface GateInput {
  scheduledAt: Date;
  sessionStatus: SessionStatus;
  candidateStatus: CandidateStatus;
  /** Set once the candidate has entered the room at least once. */
  joinedAt: Date | null;
}

/**
 * Decides whether a candidate may enter their interview room.
 *
 * Two rules, both deliberate:
 *
 *  - **Not before the scheduled time.** The room does not open early. A small
 *    tolerance absorbs clock skew between the candidate's device and the server
 *    so someone who is punctual is never told they are early.
 *
 *  - **The link expires.** If the candidate has not joined by
 *    `scheduledAt + NO_SHOW_GRACE_MINUTES`, the link stops working. This matches
 *    the point at which the scheduler marks them absent, so a candidate can
 *    never wander in an hour late and start an interview nobody is expecting.
 *
 * Once a candidate *has* joined, expiry no longer applies — an interview in
 * progress must survive a dropped connection and a reconnect.
 */
const CLOCK_SKEW_TOLERANCE_MS = 60_000;

export function evaluateJoinGate(input: GateInput, now: Date = new Date()): GateResult {
  const startsAt = input.scheduledAt.getTime();
  const graceMs = env.NO_SHOW_GRACE_MINUTES * 60_000;

  const opensAt = new Date(startsAt);
  const expiresAt = new Date(startsAt + graceMs);

  const base = { opensAt, expiresAt };
  const t = now.getTime();

  if (input.sessionStatus === 'CANCELLED' || input.candidateStatus === 'CANCELLED') {
    return { ...base, canJoin: false, verdict: 'CANCELLED', reason: 'This interview has been cancelled.' };
  }

  if (input.candidateStatus === 'COMPLETED') {
    return {
      ...base,
      canJoin: false,
      verdict: 'ALREADY_COMPLETED',
      reason: 'You have already completed this interview.',
    };
  }

  if (input.candidateStatus === 'ABSENT') {
    return {
      ...base,
      canJoin: false,
      verdict: 'MARKED_ABSENT',
      reason: 'This interview was marked as missed because nobody joined in time.',
    };
  }

  // Someone already in progress keeps their link regardless of the clock.
  const alreadyStarted = input.joinedAt !== null || input.candidateStatus === 'IN_PROGRESS' || input.candidateStatus === 'JOINED';

  if (!alreadyStarted && t < startsAt - CLOCK_SKEW_TOLERANCE_MS) {
    return {
      ...base,
      canJoin: false,
      verdict: 'TOO_EARLY',
      reason: 'This interview has not started yet. The room opens at the scheduled time.',
    };
  }

  if (!alreadyStarted && t > startsAt + graceMs) {
    return {
      ...base,
      canJoin: false,
      verdict: 'EXPIRED',
      reason: `This link has expired. The room closed ${env.NO_SHOW_GRACE_MINUTES} minutes after the scheduled start time. Contact the recruiter to be rescheduled.`,
    };
  }

  return { ...base, canJoin: true, verdict: 'OPEN', reason: null };
}
