import { google } from 'googleapis';
import { env, isMeetingProviderConfigured } from '../env';
import { CreatedMeeting, IMeetingProvider } from './MeetingProvider';

export class GoogleMeetProvider implements IMeetingProvider {
  readonly name = 'GOOGLE_MEET' as const;

  isConfigured() {
    return isMeetingProviderConfigured.google;
  }

  async createMeeting(title: string, scheduledAt: Date, durationMinutes: number): Promise<CreatedMeeting> {
    const auth = new google.auth.OAuth2(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
    auth.setCredentials({ refresh_token: env.GOOGLE_REFRESH_TOKEN });

    const calendar = google.calendar({ version: 'v3', auth });
    const end = new Date(scheduledAt.getTime() + durationMinutes * 60_000);

    const res = await calendar.events.insert({
      calendarId: 'primary',
      conferenceDataVersion: 1,
      requestBody: {
        summary: `Interview: ${title}`,
        description: 'AI-conducted interview session.',
        start: { dateTime: scheduledAt.toISOString(), timeZone: 'UTC' },
        end: { dateTime: end.toISOString(), timeZone: 'UTC' },
        conferenceData: {
          createRequest: {
            requestId: `ai-interview-${Date.now()}`,
            conferenceSolutionKey: { type: 'hangoutsMeet' },
          },
        },
      },
    });

    const link = res.data.hangoutLink;
    if (!link) throw new Error('Google Calendar returned no Meet link');

    return { provider: this.name, link, externalEventId: res.data.id ?? undefined };
  }
}