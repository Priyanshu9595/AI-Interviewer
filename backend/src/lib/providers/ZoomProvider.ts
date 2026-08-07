import { env, isMeetingProviderConfigured } from '../env';
import { CreatedMeeting, IMeetingProvider } from './MeetingProvider';

/** Zoom server-to-server OAuth. Tokens are short-lived so we fetch per call. */
export class ZoomProvider implements IMeetingProvider {
  readonly name = 'ZOOM' as const;

  isConfigured() {
    return isMeetingProviderConfigured.zoom;
  }

  private async getAccessToken(): Promise<string> {
    const basic = Buffer.from(`${env.ZOOM_CLIENT_ID}:${env.ZOOM_CLIENT_SECRET}`).toString('base64');
    const res = await fetch(
      `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${env.ZOOM_ACCOUNT_ID}`,
      { method: 'POST', headers: { Authorization: `Basic ${basic}` } },
    );

    if (!res.ok) throw new Error(`Zoom auth failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { access_token: string };
    return data.access_token;
  }

  async createMeeting(title: string, scheduledAt: Date, durationMinutes: number): Promise<CreatedMeeting> {
    const token = await this.getAccessToken();

    const res = await fetch('https://api.zoom.us/v2/users/me/meetings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: `Interview: ${title}`,
        type: 2, // scheduled
        start_time: scheduledAt.toISOString(),
        duration: durationMinutes,
        timezone: 'UTC',
        agenda: `AI-conducted interview session.\n\nView details or join via the dashboard: ${env.APP_URL}/sessions`,
        settings: { join_before_host: true, waiting_room: false },
      }),
    });

    if (!res.ok) throw new Error(`Zoom meeting creation failed: ${res.status} ${await res.text()}`);

    const data = (await res.json()) as { join_url: string; id: number };
    return { provider: this.name, link: data.join_url, externalEventId: String(data.id) };
  }
}
