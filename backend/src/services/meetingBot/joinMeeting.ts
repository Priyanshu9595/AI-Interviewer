import type { Page } from 'playwright';
import { env } from '../../lib/env';
import type { ParsedMeetingLink } from './errors';
import { driverFor, type JoinStage, type PlatformDriver } from './platforms';

/**
 * Getting the interviewer from a link to inside the meeting.
 *
 *   openMeetingLink → waitForPreJoinScreen → disableCamera → configureMicrophone
 *   → clickJoin → waitUntilJoined
 *
 * That sequence is the same on Google Meet, Zoom and Teams, but almost none of
 * the detail is — Zoom hides behind an app launcher, Teams renders pre-join in
 * an iframe, Meet asks to be let in — so each platform implements it in its own
 * driver under `platforms/` and this dispatches to the right one.
 *
 * Two things every driver refuses to do: type credentials, and work around a
 * security check. Both stop the bot with a clear message instead.
 */

export interface JoinProgress {
  stage: JoinStage;
  detail: string;
}

export interface JoinOptions {
  link: ParsedMeetingLink;
  displayName?: string;
  onProgress?: (progress: JoinProgress) => void;
  /** Overrides the configured lobby patience, for tests and manual runs. */
  admissionTimeoutMs?: number;
  /** Hold the join press until this moment; see PlatformJoinOptions.notBefore. */
  notBefore?: Date;
  signal?: AbortSignal;
}

export interface JoinResult {
  driver: PlatformDriver;
  joinedAt: Date;
  /** Whether the organiser had to let the bot in. */
  requiredAdmission: boolean;
  /** Wall time from opening the link to being inside. */
  elapsedMs: number;
}

export async function joinMeeting(page: Page, opts: JoinOptions): Promise<JoinResult> {
  const driver = driverFor(opts.link.platform);
  const startedAt = Date.now();
  let requiredAdmission = false;

  await driver.join(page, {
    link: opts.link,
    displayName: opts.displayName ?? env.MEET_BOT_DISPLAY_NAME,
    admissionTimeoutMs: opts.admissionTimeoutMs ?? env.MEET_BOT_ADMISSION_TIMEOUT_MS,
    notBefore: opts.notBefore,
    signal: opts.signal,
    onProgress: (stage, detail) => {
      if (stage === 'WAITING_FOR_ADMISSION') requiredAdmission = true;
      opts.onProgress?.({ stage, detail });
    },
  });

  return { driver, joinedAt: new Date(), requiredAdmission, elapsedMs: Date.now() - startedAt };
}
