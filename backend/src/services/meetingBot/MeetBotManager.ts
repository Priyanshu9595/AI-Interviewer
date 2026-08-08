import os from 'os';
import { randomUUID } from 'crypto';
import type { MeetBotStatus } from '@prisma/client';
import { env } from '../../lib/env';
import { prisma } from '../../lib/prisma';
import { BotError, toBotError } from './errors';
import { MeetBotSession } from './MeetBotSession';

/**
 * Owns every bot running on this process.
 *
 * Two bots joining one meeting would talk over each other and write two
 * transcripts to the same interview, so preventing that is the job here. It
 * takes two locks because neither alone is enough: an in-memory map catches a
 * second request to this process, and a conditional database update catches a
 * second replica or a scheduler tick that overlapped its predecessor.
 *
 * Nothing is held in memory that matters. Runs live in the database, so a
 * restart loses only the browsers — the schedule survives, and interviews whose
 * process died are picked back up by `recoverOrphans`.
 */

/** Identifies this process in the lock column. */
const INSTANCE_ID = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

/** Statuses that mean a bot is live somewhere. */
const ACTIVE_STATUSES: MeetBotStatus[] = [
  'STARTING',
  'OPENING_MEETING',
  'PRE_JOIN',
  'WAITING_FOR_ADMISSION',
  'JOINED',
  'WAITING_FOR_CANDIDATE',
  'INTRODUCTION',
  'QUESTIONING',
  'FOLLOW_UP',
  'FINAL_QUESTION',
  'ENDING',
];

/** A recruiter may restart an interview that failed or was stopped. */
const MANUALLY_STARTABLE: MeetBotStatus[] = ['SCHEDULED', 'FAILED', 'CANCELLED'];

/**
 * A lock older than this belonged to a process that is gone.
 *
 * Comfortably longer than the slowest legitimate join — ten minutes in a lobby
 * plus the wait for a candidate — so a live interview is never stolen.
 */
const STALE_LOCK_MS = 45 * 60_000;

/** Anything the session emits, forwarded to whoever is listening. */
export type BotEventName =
  | 'status'
  | 'joined'
  | 'message'
  | 'question'
  | 'answer'
  | 'interim'
  | 'completed'
  | 'error';

type EventSink = (interviewId: string, event: BotEventName, payload: unknown) => void;

export class MeetBotManager {
  private static readonly sessions = new Map<string, MeetBotSession>();

  /**
   * Set by the realtime gateway. A callback rather than an import so the
   * manager does not depend on the socket layer — the bot has to work in a
   * worker or a script with no server attached.
   */
  private static sink: EventSink = () => {};

  static setEventSink(sink: EventSink): void {
    this.sink = sink;
  }

  static isRunning(interviewId: string): boolean {
    return this.sessions.has(interviewId);
  }

  static activeCount(): number {
    return this.sessions.size;
  }

  static statusOf(interviewId: string): MeetBotStatus | null {
    return this.sessions.get(interviewId)?.currentStatus ?? null;
  }

  /**
   * Tells a running interview that its coding exercise was submitted.
   *
   * The candidate submits over HTTP from a browser tab that knows nothing about
   * the meeting, so this is how the two halves meet. A no-op when no bot is
   * running — a submission from the built-in room takes its own path.
   */
  static async notifyCodingSubmitted(
    interviewId: string,
    summary: { passed: number; total: number },
  ): Promise<boolean> {
    const session = this.sessions.get(interviewId);
    if (!session) return false;

    await session.codingSubmitted(summary).catch((err) =>
      console.error(`[meet-bot ${interviewId}] coding submission handoff failed:`, (err as Error).message),
    );
    return true;
  }

  // -------------------------------------------------------------------------
  // Starting
  // -------------------------------------------------------------------------

  /**
   * Launches the bot for one interview.
   *
   * Returns without doing anything if this process is already running it, which
   * makes the call safe to repeat — the scheduler does exactly that every tick.
   */
  static async start(interviewId: string, opts: { manual: boolean } = { manual: false }): Promise<void> {
    if (!env.MEET_BOT_ENABLED) throw new BotError('BOT_DISABLED');
    if (this.sessions.has(interviewId)) return;

    if (this.sessions.size >= env.MEET_BOT_MAX_CONCURRENT) {
      throw new BotError(
        'CAPACITY_REACHED',
        `${this.sessions.size} of ${env.MEET_BOT_MAX_CONCURRENT} concurrent meetings already running`,
      );
    }

    const claimed = await this.claim(interviewId, opts.manual);
    if (!claimed) {
      // Either another replica has it, or it is in a status that cannot be
      // started. Both mean: do not launch a second browser.
      const run = await prisma.meetBotRun.findUnique({
        where: { sessionCandidateId: interviewId },
        select: { status: true, lockedBy: true },
      });

      if (!run) throw new BotError('RUN_NOT_FOUND');
      if (ACTIVE_STATUSES.includes(run.status)) throw new BotError('ALREADY_RUNNING', `status ${run.status}`);
      throw new BotError('NOT_STARTABLE', `status ${run.status}`);
    }

    const session = new MeetBotSession(interviewId, { manualStart: opts.manual });
    this.sessions.set(interviewId, session);

    for (const event of ['status', 'joined', 'message', 'question', 'answer', 'interim', 'completed', 'error'] as const) {
      session.on(event, (payload: unknown) => this.sink(interviewId, event, payload));
    }

    session.once('finished', () => {
      this.sessions.delete(interviewId);
      void prisma.meetBotRun
        .update({ where: { sessionCandidateId: interviewId }, data: { lockedBy: null, lockedAt: null } })
        .catch(() => {});
    });

    // Deliberately not awaited: an interview runs for half an hour, and the
    // caller is an HTTP request or a scheduler tick. Failures are recorded on
    // the run by the session itself.
    void session.run().catch((err) => {
      console.error(`[meet-bot ${interviewId}] unhandled failure:`, toBotError(err).message);
      this.sessions.delete(interviewId);
    });
  }

  /**
   * Takes ownership of a run, if it is available.
   *
   * The condition and the write are one statement on purpose — two processes
   * checking and then writing would both see it free.
   */
  private static async claim(interviewId: string, manual: boolean): Promise<boolean> {
    const startable = manual ? MANUALLY_STARTABLE : (['SCHEDULED'] as MeetBotStatus[]);
    const staleBefore = new Date(Date.now() - STALE_LOCK_MS);

    const { count } = await prisma.meetBotRun.updateMany({
      where: {
        sessionCandidateId: interviewId,
        status: { in: startable },
        // Free, ours already, or abandoned by a process that no longer exists.
        OR: [{ lockedBy: null }, { lockedBy: INSTANCE_ID }, { lockedAt: { lt: staleBefore } }],
      },
      data: { lockedBy: INSTANCE_ID, lockedAt: new Date(), status: 'STARTING' },
    });

    return count === 1;
  }

  // -------------------------------------------------------------------------
  // Stopping
  // -------------------------------------------------------------------------

  static async stop(interviewId: string, reason = 'Stopped from the dashboard'): Promise<boolean> {
    const session = this.sessions.get(interviewId);

    if (!session) {
      // Not ours. Mark it cancelled so it is not started later, and release the
      // lock in case the owning process is gone.
      const { count } = await prisma.meetBotRun.updateMany({
        where: { sessionCandidateId: interviewId, status: { notIn: ['COMPLETED', 'FAILED', 'CANCELLED'] } },
        data: { status: 'CANCELLED', statusDetail: reason, endedAt: new Date(), lockedBy: null, lockedAt: null },
      });
      return count > 0;
    }

    await session.stop(reason);
    return true;
  }

  /** Closes every browser on shutdown so no orphan Chromium is left behind. */
  static async shutdown(): Promise<void> {
    const running = [...this.sessions.values()];
    if (!running.length) return;

    console.log(`[meet-bot] stopping ${running.length} running interview(s)`);
    await Promise.allSettled(running.map((s) => s.stop('The server is shutting down')));
  }

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  /**
   * Starts every interview whose lead time has arrived.
   *
   * Called from the scheduler tick, so it must be cheap when there is nothing
   * to do and must never throw — a failure here would take the rest of the tick
   * (reminders, evaluations) down with it.
   */
  static async startDue(): Promise<void> {
    if (!env.MEET_BOT_ENABLED) return;
    if (this.sessions.size >= env.MEET_BOT_MAX_CONCURRENT) return;

    const now = new Date();

    const due = await prisma.meetBotRun.findMany({
      where: { status: 'SCHEDULED', joinAt: { lte: now } },
      include: {
        sessionCandidate: {
          select: { status: true, interviewSession: { select: { scheduledAt: true, status: true } } },
        },
      },
      orderBy: { joinAt: 'asc' },
      take: 20,
    });

    for (const run of due) {
      if (this.sessions.size >= env.MEET_BOT_MAX_CONCURRENT) return;

      const session = run.sessionCandidate.interviewSession;

      if (session.status === 'CANCELLED' || ['CANCELLED', 'COMPLETED'].includes(run.sessionCandidate.status)) {
        await this.close(run.sessionCandidateId, 'CANCELLED', 'The interview was cancelled');
        continue;
      }

      // The whole window elapsed while nothing was running — a restart during
      // the slot, most likely. Starting now would join a meeting long since
      // over, so record the miss instead.
      const windowClosedAt =
        session.scheduledAt.getTime() +
        (env.MEET_BOT_CANDIDATE_WAIT_MINUTES + env.MEET_BOT_CANDIDATE_GRACE_MINUTES) * 60_000;

      if (now.getTime() > windowClosedAt) {
        await this.close(
          run.sessionCandidateId,
          'CANCELLED',
          'Cancelled — the interview window passed before the AI interviewer could join',
          'CANDIDATE_NO_SHOW',
        );
        continue;
      }

      try {
        await this.start(run.sessionCandidateId, { manual: false });
        console.log(`[meet-bot] started ${run.sessionCandidateId} for ${session.scheduledAt.toISOString()}`);
      } catch (err) {
        const error = toBotError(err);
        if (error.code === 'CAPACITY_REACHED') return;
        console.error(`[meet-bot] could not start ${run.sessionCandidateId}:`, error.message);
        await this.close(run.sessionCandidateId, 'FAILED', error.message, error.code);
      }
    }
  }

  /**
   * The next few interviews the bot is due to launch.
   *
   * Auto-join only happens while this process is alive, and the commonest
   * reason an interview "did not join automatically" is that nothing was
   * running when its moment came. Printing the queue at boot turns that from a
   * silent no-op into something visible before it matters.
   */
  static async upcoming(limit = 5) {
    const runs = await prisma.meetBotRun
      .findMany({
        where: { status: 'SCHEDULED' },
        orderBy: { joinAt: 'asc' },
        take: limit,
        include: {
          sessionCandidate: {
            select: {
              candidate: { select: { name: true } },
              interviewSession: { select: { scheduledAt: true } },
            },
          },
        },
      })
      .catch(() => []);

    return runs.map((run) => ({
      interviewId: run.sessionCandidateId,
      candidateName: run.sessionCandidate.candidate.name,
      platform: run.platform,
      joinAt: run.joinAt,
      scheduledAt: run.sessionCandidate.interviewSession.scheduledAt,
      overdue: run.joinAt.getTime() < Date.now(),
    }));
  }

  /** One line per upcoming launch, for the boot log. */
  static async logUpcoming(): Promise<void> {
    if (!env.MEET_BOT_ENABLED) return;

    const next = await this.upcoming(5);
    if (!next.length) {
      console.log('[meet-bot] no interviews scheduled');
      return;
    }

    console.log(`[meet-bot] ${next.length} interview(s) queued:`);
    for (const item of next) {
      const when = item.joinAt.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
      console.log(
        `           ${item.candidateName} (${item.platform}) — joining ${when}${item.overdue ? ' [overdue, starting now]' : ''}`,
      );
    }
  }

  /**
   * Starts one interview now if its lead time has already passed.
   *
   * Called the moment an interview is created. Scheduling one for "in two
   * minutes" — or for right now, which is what testing looks like — puts its
   * join time in the past, and without this it would sit there until the next
   * scheduler tick, up to a minute of apparently nothing happening. Waiting for
   * a clock that has already struck is not scheduling, it is latency.
   *
   * Never throws: creating the interview succeeded, and that is what the
   * recruiter is waiting on.
   */
  static async startIfDue(interviewId: string): Promise<boolean> {
    if (!env.MEET_BOT_ENABLED) return false;

    const run = await prisma.meetBotRun
      .findUnique({ where: { sessionCandidateId: interviewId }, select: { joinAt: true, status: true } })
      .catch(() => null);

    if (!run || run.status !== 'SCHEDULED') return false;
    if (run.joinAt.getTime() > Date.now()) return false;

    try {
      await this.start(interviewId, { manual: false });
      console.log(`[meet-bot] ${interviewId} was already due — started immediately`);
      return true;
    } catch (err) {
      // The scheduler will pick it up on its next pass.
      console.warn(`[meet-bot] could not start ${interviewId} immediately:`, toBotError(err).message);
      return false;
    }
  }

  /**
   * Clears runs whose process died.
   *
   * Called once at boot. Only touches locks old enough that no live interview
   * could still hold them, so it is safe to run with other replicas up.
   */
  static async recoverOrphans(): Promise<void> {
    if (!env.MEET_BOT_ENABLED) return;

    const staleBefore = new Date(Date.now() - STALE_LOCK_MS);

    const { count } = await prisma.meetBotRun.updateMany({
      where: {
        status: { in: ACTIVE_STATUSES },
        OR: [{ lockedAt: { lt: staleBefore } }, { lockedAt: null }],
      },
      data: {
        status: 'FAILED',
        errorCode: 'BROWSER_CRASHED',
        errorMessage: 'The server restarted while this interview was running.',
        statusDetail: 'Interrupted by a server restart',
        endedAt: new Date(),
        lockedBy: null,
        lockedAt: null,
      },
    });

    if (count) console.log(`[meet-bot] released ${count} interview(s) left running by a previous process`);
  }

  private static async close(
    interviewId: string,
    status: MeetBotStatus,
    detail: string,
    code?: string,
  ): Promise<void> {
    await prisma.meetBotRun
      .update({
        where: { sessionCandidateId: interviewId },
        data: {
          status,
          statusDetail: detail,
          errorCode: code ?? null,
          errorMessage: status === 'FAILED' ? detail : null,
          endedAt: new Date(),
          lockedBy: null,
          lockedAt: null,
        },
      })
      .catch(() => {});

    this.sink(interviewId, 'status', { status, detail });
  }
}
