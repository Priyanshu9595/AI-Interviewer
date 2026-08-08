import { BotError, PLATFORM_LABEL, type MeetingPlatform, type ParsedMeetingLink } from '../errors';
import { googleMeetDriver } from './googleMeet';
import { teamsDriver } from './teams';
import { zoomDriver } from './zoom';
import type { PlatformDriver } from './types';

export * from './types';

/**
 * Every platform the interviewer can join.
 *
 * Order matters only for `detect`, and the patterns do not overlap, so it is
 * alphabetical by nothing in particular. Adding a fourth platform means writing
 * one driver and adding it here — nothing above this line needs to change.
 */
export const DRIVERS: readonly PlatformDriver[] = [googleMeetDriver, zoomDriver, teamsDriver];

const BY_PLATFORM = new Map<MeetingPlatform, PlatformDriver>(DRIVERS.map((d) => [d.platform, d]));

export const driverFor = (platform: MeetingPlatform): PlatformDriver => {
  const driver = BY_PLATFORM.get(platform);
  if (!driver) throw new BotError('UNSUPPORTED_PLATFORM', platform);
  return driver;
};

/** Which platform a link belongs to, or null if none recognise it. */
export function detectPlatform(input: string): MeetingPlatform | null {
  const trimmed = (input ?? '').trim();
  if (!trimmed) return null;
  return DRIVERS.find((d) => d.matches(trimmed))?.platform ?? null;
}

/**
 * Validates and canonicalises any supported meeting link.
 *
 * Called before a run is stored as well as before the browser is launched, so a
 * recruiter finds out about a mistyped link while the form is still open rather
 * than at the scheduled time with nobody watching.
 */
export function parseMeetingLink(input: string): ParsedMeetingLink {
  const trimmed = (input ?? '').trim();
  if (!trimmed) throw new BotError('INVALID_MEETING_URL', 'empty link');

  const platform = detectPlatform(trimmed);
  if (!platform) {
    throw new BotError(
      'INVALID_MEETING_URL',
      trimmed.slice(0, 120),
      'That does not look like a meeting link. Paste a Google Meet, Zoom or Microsoft Teams link.',
    );
  }

  return driverFor(platform).parse(trimmed);
}

/** True when the link is one the bot can actually drive. */
export function isSupportedMeetingLink(input: string): boolean {
  try {
    parseMeetingLink(input);
    return true;
  } catch {
    return false;
  }
}

/** Whether joining this platform needs the signed-in bot profile. */
export const platformRequiresSignIn = (platform: MeetingPlatform): boolean =>
  driverFor(platform).requiresSignIn;

export const platformLabel = (platform: MeetingPlatform): string => PLATFORM_LABEL[platform] ?? platform;
