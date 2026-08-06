export type MeetingProviderName = 'GOOGLE_MEET' | 'ZOOM' | 'MS_TEAMS' | 'BUILT_IN';

export interface CreatedMeeting {
  provider: MeetingProviderName;
  link: string;
  externalEventId?: string;
}

export interface IMeetingProvider {
  readonly name: MeetingProviderName;
  isConfigured(): boolean;
  createMeeting(title: string, scheduledAt: Date, durationMinutes: number): Promise<CreatedMeeting>;
}