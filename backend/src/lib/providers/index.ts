import { GoogleMeetProvider } from './GoogleMeetProvider';
import { CreatedMeeting, IMeetingProvider, MeetingProviderName } from './MeetingProvider';
import { TeamsProvider } from './TeamsProvider';
import { ZoomProvider } from './ZoomProvider';

const registry: Record<MeetingProviderName, IMeetingProvider> = {
  GOOGLE_MEET: new GoogleMeetProvider(),
  ZOOM: new ZoomProvider(),
  MS_TEAMS: new TeamsProvider(),
};

export const availableProviders = () =>
  (Object.keys(registry) as MeetingProviderName[]).map((name) => ({
    name,
    configured: registry[name].isConfigured(),
  }));

/** Raised when a meeting cannot be created, rather than quietly substituting one. */
export class MeetingCreationError extends Error {}

/**
 * Creates a meeting with the requested provider.
 *
 * This used to fall back to the platform's own browser room whenever the
 * provider was unconfigured or its API said no, on the reasoning that a broken
 * calendar integration should never block scheduling. The reasoning was wrong
 * in one specific way: the fallback was silent. A recruiter who asked for Zoom
 * got a scheduled interview, an invitation email and no indication that the
 * link inside it was not a Zoom link at all.
 *
 * Every interview is now a real meeting the AI interviewer joins, so there is
 * nothing to fall back to. Failing here is loud and recoverable; the recruiter
 * connects the integration and schedules again.
 */
export async function createMeeting(
  requested: MeetingProviderName | null | undefined,
  title: string,
  scheduledAt: Date,
  durationMinutes: number,
): Promise<CreatedMeeting> {
  if (!requested) {
    throw new MeetingCreationError('Choose Google Meet, Zoom or Microsoft Teams for this interview.');
  }

  const provider = registry[requested];

  if (!provider?.isConfigured()) {
    throw new MeetingCreationError(
      `${requested} is not connected, so no meeting could be created. Connect it under Integrations, or paste an existing meeting link instead.`,
    );
  }

  try {
    return await provider.createMeeting(title, scheduledAt, durationMinutes);
  } catch (err) {
    throw new MeetingCreationError(`${provider.name} refused to create the meeting: ${(err as Error).message}`);
  }
}

export type { CreatedMeeting, MeetingProviderName };
