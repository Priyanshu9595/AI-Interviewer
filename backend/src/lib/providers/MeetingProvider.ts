/**
 * BUILT_IN was a fourth member: the platform's own browser interview room.
 * It is gone deliberately — every interview now happens in a real meeting the
 * AI interviewer joins. Rows written before that still carry the old string,
 * which is why the column stays a plain String rather than an enum.
 */
export type MeetingProviderName = 'GOOGLE_MEET' | 'ZOOM' | 'MS_TEAMS';

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