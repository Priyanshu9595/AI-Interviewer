import { EventEmitter } from 'events';
import type { Page } from 'playwright';
import type { MeetingObservation, PlatformDriver } from './platforms';

/**
 * Watches the meeting while the interview runs.
 *
 * It answers two questions the interview engine cannot answer for itself: is
 * anyone else here, and are we still in the call. The first decides when the
 * introduction starts — the bot joins early and must not talk to an empty room.
 * The second is how a meeting that ends underneath the interview gets noticed,
 * rather than the bot continuing to ask questions into a closed call.
 *
 * How those are read differs per platform, so the reading is delegated to the
 * driver and the debouncing lives here, once, for all three.
 */

export interface MeetingMonitorEvents {
  /** The first other participant arrived. */
  candidateArrived: MeetingObservation;
  /** Everyone else left, having been present. */
  alone: MeetingObservation;
  /** The bot is no longer in the call. */
  ended: { reason: 'ENDED' | 'REMOVED' };
  /** Someone was let in from the waiting room. */
  admitted: { count: number };
  snapshot: MeetingObservation;
}

const POLL_MS = 3_000;

export class MeetingMonitor extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private stopped = false;

  private sawOthers = false;
  private last: MeetingObservation | null = null;

  /**
   * Consecutive readings before a state change is believed.
   *
   * All three clients re-render their participant lists during a layout change
   * and briefly report one participant, and all three can flash an "ended"
   * looking screen mid-reconnect. Requiring the reading to hold stops a blip
   * from ending a live interview.
   */
  private emptyStreak = 0;
  private endedStreak = 0;
  private static readonly STREAK_THRESHOLD = 3;

  constructor(
    private readonly page: Page,
    private readonly driver: PlatformDriver,
  ) {
    super();
  }

  get snapshot(): MeetingObservation | null {
    return this.last;
  }

  /** True once anyone other than the bot has been seen in the meeting. */
  get candidateHasJoined(): boolean {
    return this.sawOthers;
  }

  /** Someone is knocking right now but has not been admitted. */
  get someoneWaiting(): boolean {
    return this.last?.waitingRoomOccupied ?? false;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.removeAllListeners();
  }

  private async poll(): Promise<void> {
    if (this.polling || this.stopped || this.page.isClosed()) return;
    this.polling = true;

    try {
      const snapshot = await this.driver.observe(this.page);
      this.last = snapshot;
      this.emit('snapshot', snapshot);

      if (snapshot.ended) {
        // A single "ended" reading is often a reconnect or a dialog covering
        // the call controls. Three in a row is the meeting actually being over.
        this.endedStreak++;
        if (this.endedStreak >= MeetingMonitor.STREAK_THRESHOLD) {
          this.emit('ended', { reason: snapshot.endReason ?? 'ENDED' });
          this.stop();
        }
        return;
      }

      this.endedStreak = 0;

      // The recruiter usually creates the meeting from the same account the
      // bot signs in as, which makes the bot the host. A host that never
      // presses Admit leaves the candidate in the waiting room for the entire
      // interview — so this runs on every tick, whether anyone is waiting or not.
      const admitted = await this.driver.admitWaiting(this.page).catch(() => 0);
      if (admitted > 0) {
        console.log(`[meet-bot] admitted ${admitted} waiting participant(s)`);
        this.emit('admitted', { count: admitted });
      }

      if (snapshot.participants > 1) {
        this.emptyStreak = 0;
        if (!this.sawOthers) {
          this.sawOthers = true;
          this.emit('candidateArrived', snapshot);
        }
        return;
      }

      // A count of zero means the page could not be read, not that the meeting
      // is empty. Only a confident count of one is evidence of being alone.
      if (this.sawOthers && snapshot.participants === 1) {
        this.emptyStreak++;
        if (this.emptyStreak >= MeetingMonitor.STREAK_THRESHOLD) {
          this.emptyStreak = 0;
          this.emit('alone', snapshot);
        }
      }
    } catch {
      // A poll that throws is usually a page mid-navigation. The next tick will
      // see the real state; a monitor that dies takes the interview with it.
    } finally {
      this.polling = false;
    }
  }
}

/**
 * Leaves the meeting politely.
 *
 * Clicking Leave lets the platform tell the candidate the interviewer has gone,
 * rather than leaving a frozen tile until the connection times out.
 */
export async function leaveMeeting(page: Page, driver: PlatformDriver): Promise<void> {
  if (page.isClosed()) return;
  await driver.leave(page).catch(() => {});
}
