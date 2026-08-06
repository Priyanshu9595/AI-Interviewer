import { env } from '../env';
import { CreatedMeeting, IMeetingProvider } from './MeetingProvider';

/**
 * The platform's own interview room. Always available, and the only provider
 * where the AI interviewer can actually hear and speak to the candidate — the
 * external providers produce a calendar invite whose link redirects here.
 *
 * The real per-candidate URL is built later from the candidate's access token;
 * this returns the room's base path.
 */
export class BuiltInProvider implements IMeetingProvider {
  readonly name = 'BUILT_IN' as const;

  isConfigured() {
    return true;
  }

  async createMeeting(): Promise<CreatedMeeting> {
    return { provider: this.name, link: `${env.APP_URL}/interview` };
  }
}
