import { BuiltInProvider } from './BuiltInProvider';
import { GoogleMeetProvider } from './GoogleMeetProvider';
import { CreatedMeeting, IMeetingProvider, MeetingProviderName } from './MeetingProvider';
import { TeamsProvider } from './TeamsProvider';
import { ZoomProvider } from './ZoomProvider';

const registry: Record<MeetingProviderName, IMeetingProvider> = {
  GOOGLE_MEET: new GoogleMeetProvider(),
  ZOOM: new ZoomProvider(),
  MS_TEAMS: new TeamsProvider(),
  BUILT_IN: new BuiltInProvider(),
};

export const availableProviders = () =>
  (Object.keys(registry) as MeetingProviderName[]).map((name) => ({
    name,
    configured: registry[name].isConfigured(),
  }));

/**
 * Creates a meeting with the requested provider, falling back to the built-in
 * room when the provider is unconfigured or its API rejects the request. A
 * failed calendar integration must never block scheduling an interview.
 */
export async function createMeeting(
  requested: MeetingProviderName | null | undefined,
  title: string,
  scheduledAt: Date,
  durationMinutes: number,
): Promise<CreatedMeeting> {
  const provider = requested ? registry[requested] : undefined;

  if (provider && provider.isConfigured()) {
    try {
      return await provider.createMeeting(title, scheduledAt, durationMinutes);
    } catch (err) {
      console.warn(`[meeting] ${provider.name} failed, using built-in room:`, (err as Error).message);
    }
  } else if (requested === 'BUILT_IN') {
    // If built-in is requested, we STILL want to create a calendar event automatically 
    // on Google Meet, Zoom, or Teams if they are configured, so the recruiter's calendar is blocked.
    const autoProviders: MeetingProviderName[] = ['GOOGLE_MEET', 'ZOOM', 'MS_TEAMS'];
    for (const p of autoProviders) {
      if (registry[p].isConfigured()) {
        try {
          return await registry[p].createMeeting(title, scheduledAt, durationMinutes);
        } catch (err) {
          console.warn(`[meeting] Auto ${p} failed, trying next:`, (err as Error).message);
        }
      }
    }
  } else if (requested) {
    console.warn(`[meeting] ${requested} is not configured, using built-in room`);
  }

  return registry.BUILT_IN.createMeeting(title, scheduledAt, durationMinutes);
}

export type { CreatedMeeting, MeetingProviderName };
