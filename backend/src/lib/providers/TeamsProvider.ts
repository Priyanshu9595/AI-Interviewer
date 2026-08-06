import { env, isMeetingProviderConfigured } from '../env';
import { CreatedMeeting, IMeetingProvider } from './MeetingProvider';

/** Microsoft Teams via Graph API using client-credentials flow. */
export class TeamsProvider implements IMeetingProvider {
  readonly name = 'MS_TEAMS' as const;

  isConfigured() {
    return isMeetingProviderConfigured.teams;
  }

  private async getAccessToken(): Promise<string> {
    const body = new URLSearchParams({
      client_id: env.MS_CLIENT_ID ?? '',
      client_secret: env.MS_CLIENT_SECRET ?? '',
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    });

    const res = await fetch(`https://login.microsoftonline.com/${env.MS_TENANT_ID}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!res.ok) throw new Error(`Microsoft auth failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { access_token: string };
    return data.access_token;
  }

  async createMeeting(title: string, scheduledAt: Date, durationMinutes: number): Promise<CreatedMeeting> {
    const token = await this.getAccessToken();
    const end = new Date(scheduledAt.getTime() + durationMinutes * 60_000);

    const res = await fetch(`https://graph.microsoft.com/v1.0/users/${env.MS_ORGANIZER_ID}/onlineMeetings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subject: `Interview: ${title}`,
        startDateTime: scheduledAt.toISOString(),
        endDateTime: end.toISOString(),
      }),
    });

    if (!res.ok) throw new Error(`Teams meeting creation failed: ${res.status} ${await res.text()}`);

    const data = (await res.json()) as { joinWebUrl: string; id: string };
    return { provider: this.name, link: data.joinWebUrl, externalEventId: data.id };
  }
}
