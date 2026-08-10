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
  /**
   * Somebody has been visibly knocking for a while and every attempt to admit
   * them has failed. Almost always a selector that no longer matches, and
   * without this it is indistinguishable from nobody turning up.
   */
  admissionStuck: { seconds: number };
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

  /** Consecutive polls with somebody waiting who could not be admitted. */
  private waitingStreak = 0;
  private reportedStuck = false;

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

      // Logged whenever the reading changes. A head-count stuck at 0 or 1 while
      // the bot is plainly hearing people is the signature of drifted
      // selectors, and without this it is invisible — the interview simply
      // waits out its window and records a no-show.
      if (this.last?.participants !== snapshot.participants) {
        console.log(
          `[meet-bot] participants: ${snapshot.participants}` +
            `${snapshot.waitingRoomOccupied ? ', someone waiting to be let in' : ''}`,
        );
      }

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
      let admitted = 0;
      try {
        admitted = await this.driver.admitWaiting(this.page);
      } catch (err) {
        // Swallowing this was a mistake: it made a broken selector look exactly
        // like an empty waiting room, and the interview was scored a no-show.
        console.warn(`[meet-bot] admitWaiting threw: ${(err as Error).message}`);
      }

      if (admitted > 0) {
        console.log(`[meet-bot] admitted ${admitted} waiting participant(s)`);
        this.waitingStreak = 0;
        this.reportedStuck = false;
        this.emit('admitted', { count: admitted });
      } else if (snapshot.waitingRoomOccupied) {
        this.waitingStreak++;

        // Roughly fifteen seconds of somebody knocking with nothing happening.
        // Long enough not to fire on the animation of a prompt appearing.
        if (!this.reportedStuck && this.waitingStreak >= 5) {
          this.reportedStuck = true;
          this.emit('admissionStuck', { seconds: this.waitingStreak * (POLL_MS / 1000) });
        }
      } else {
        this.waitingStreak = 0;
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
