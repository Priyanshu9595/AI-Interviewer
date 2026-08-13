import { ReminderKind } from '@prisma/client';
import { emailService } from '../lib/email/EmailService';
import { env } from '../lib/env';
import { prisma } from '../lib/prisma';
import { EvaluationQueue } from './EvaluationQueue';
import { ResumeService } from './ResumeService';
import { MeetBotManager } from './meetingBot/MeetBotManager';

/** How far ahead of the interview each reminder fires. */
const OFFSETS: Array<{ kind: ReminderKind; ms: number; label: string }> = [
  { kind: 'T_MINUS_24H', ms: 24 * 60 * 60_000, label: '24 hours' },
  { kind: 'T_MINUS_1H', ms: 60 * 60_000, label: '1 hour' },
  { kind: 'T_MINUS_5M', ms: 5 * 60_000, label: '5 minutes' },
];

/**
 * Where a candidate is told to go.
 *
 * An interview the AI runs inside a Google Meet has to send the candidate to
 * that meeting; the built-in room's own link would put them somewhere the
 * interviewer is not.
 */
const joinUrlFor = (sc: { accessToken: string; meetBotRun?: { meetLink: string } | null }) =>
  sc.meetBotRun?.meetLink ?? `${env.APP_URL}/interview/${sc.accessToken}`;

/**
 * Where a meeting-interview candidate writes their code.
 *
 * Deliberately **not** included in the invitation by default. Sending it ahead
 * of time hands the candidate the exercise before the interviewer has asked for
 * it, which is the wrong order — the round is meant to start when the
 * interviewer says so. The bot posts the link into the meeting chat instead.
 *
 * Set MEET_BOT_CODING_LINK_IN_EMAIL=true to send it up front as well, as a
 * safety net for meetings whose chat the candidate cannot see.
 */
const codingUrlFor = (sc: {
  accessToken: string;
  meetBotRun?: unknown;
  interviewSession: { codingEnabled: boolean };
}) =>
  env.MEET_BOT_CODING_LINK_IN_EMAIL && sc.meetBotRun && sc.interviewSession.codingEnabled
    ? `${env.APP_URL}/interview/${sc.accessToken}/code`
    : undefined;

export class SchedulerService {
  private static timer: NodeJS.Timeout | null = null;
  private static running = false;

  /**
   * Queues the invite plus the three reminders for one candidate. Reminders
   * whose moment has already passed are marked SKIPPED rather than fired late,
   * so adding a candidate an hour before the interview does not spam them.
   */
  static async scheduleFor(sessionCandidateId: string) {
    const sc = await prisma.sessionCandidate.findUnique({
      where: { id: sessionCandidateId },
      include: { interviewSession: true },
    });
    if (!sc) return;

    const startsAt = sc.interviewSession.scheduledAt.getTime();
    const now = Date.now();

    const rows = OFFSETS.map((o) => ({
      sessionCandidateId,
      kind: o.kind,
      scheduledFor: new Date(startsAt - o.ms),
      status: startsAt - o.ms < now ? ('SKIPPED' as const) : ('PENDING' as const),
    }));

    // Invite goes out immediately.
    rows.push({
      sessionCandidateId,
      kind: 'INVITE' as ReminderKind,
      scheduledFor: new Date(),
      status: 'PENDING' as const,
    });

    await prisma.reminder.createMany({ data: rows, skipDuplicates: true });
  }

  /** Re-times pending reminders and bot launches after a session moves. */
  static async reschedule(interviewSessionId: string) {
    const session = await prisma.interviewSession.findUnique({
      where: { id: interviewSessionId },
      include: { candidates: { select: { id: true } } },
    });
    if (!session) return;

    const startsAt = session.scheduledAt.getTime();
    const now = Date.now();
    const candidateIds = session.candidates.map((c) => c.id);

    for (const o of OFFSETS) {
      const when = new Date(startsAt - o.ms);
      await prisma.reminder.updateMany({
        where: { kind: o.kind, status: 'PENDING', sessionCandidateId: { in: candidateIds } },
        data: { scheduledFor: when, status: startsAt - o.ms < now ? 'SKIPPED' : 'PENDING' },
      });
    }

    // The bot's launch time has to move with the interview. Without this a
    // rescheduled session keeps its original joinAt, so the bot either turns up
    // to a meeting that is not happening yet or — far more often — is written
    // off as a missed window and never joins at all.
    const { count } = await prisma.meetBotRun.updateMany({
      where: { sessionCandidateId: { in: candidateIds }, status: 'SCHEDULED' },
      data: { joinAt: new Date(startsAt - env.MEET_BOT_JOIN_LEAD_MINUTES * 60_000) },
    });

    if (count) {
      console.log(`[scheduler] re-timed ${count} bot launch(es) for session ${interviewSessionId}`);
      // The moved interview may now be the next one due.
      await MeetBotManager.armNextLaunch();
    }
  }

  /** Cancels everything still queued for a session. */
  static async cancelForSession(interviewSessionId: string) {
    const candidates = await prisma.sessionCandidate.findMany({
      where: { interviewSessionId },
      select: { id: true },
    });

    await prisma.reminder.updateMany({
      where: { sessionCandidateId: { in: candidates.map((c) => c.id) }, status: 'PENDING' },
      data: { status: 'SKIPPED' },
    });
  }

  // -------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------

  static start() {
    if (!env.SCHEDULER_ENABLED) {
      console.log('[scheduler] disabled by configuration');
      return;
    }
    if (this.timer) return;

    console.log(`[scheduler] running every ${env.SCHEDULER_INTERVAL_MS / 1000}s`);
    void this.tick();
    this.timer = setInterval(() => void this.tick(), env.SCHEDULER_INTERVAL_MS);
  }

  static stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass: send due reminders, activate sessions, close out no-shows. */
  static async tick() {
    if (this.running) return; // a slow tick must not overlap the next one
    this.running = true;

    try {
      await this.sendDueReminders();
      await this.activateDueSessions();
      // Launches the Google Meet bot for interviews whose lead time has come.
      // Runs before the no-show sweep so a bot is already waiting in the
      // meeting by the time anyone is considered late.
      await MeetBotManager.startDue();
      // Nudge before marking absent, so a candidate is never written off in the
      // same tick that they were first chased.
      await this.sendNoShowNudges();
      await this.markNoShows();
      await this.closeFinishedSessions();
      // A completed interview with no report is outstanding work, not a dead end.
      await EvaluationQueue.processPending();
      // Resumes stored while the LLM was down still need analysing.
      await ResumeService.analysePending();
    } catch (err) {
      console.error('[scheduler] tick failed:', (err as Error).message);
    } finally {
      this.running = false;
    }
  }

  private static async sendDueReminders() {
    const due = await prisma.reminder.findMany({
      where: { status: 'PENDING', scheduledFor: { lte: new Date() }, attempts: { lt: 3 } },
      include: {
        sessionCandidate: {
          include: { candidate: true, interviewSession: true, meetBotRun: true },
        },
      },
      take: 50,
    });

    for (const reminder of due) {
      const sc = reminder.sessionCandidate;
      const session = sc.interviewSession;

      // Never chase a candidate who has already been through the interview.
      if (session.status === 'CANCELLED' || ['COMPLETED', 'ABSENT', 'CANCELLED'].includes(sc.status)) {
        await prisma.reminder.update({ where: { id: reminder.id }, data: { status: 'SKIPPED' } });
        continue;
      }

      try {
        if (reminder.kind === 'INVITE') {
          await emailService.sendInvite({
            to: sc.candidate.email,
            name: sc.candidate.name,
            role: session.title,
            joinUrl: joinUrlFor(sc),
            scheduledAt: session.scheduledAt,
            durationMinutes: session.durationMinutes,
            codingUrl: codingUrlFor(sc),
          });
          await prisma.sessionCandidate.update({
            where: { id: sc.id },
            data: { invitedAt: new Date() },
          });
        } else {
          const label = OFFSETS.find((o) => o.kind === reminder.kind)?.label ?? 'soon';
          await emailService.sendReminder({
            to: sc.candidate.email,
            name: sc.candidate.name,
            role: session.title,
            joinUrl: joinUrlFor(sc),
            scheduledAt: session.scheduledAt,
            timeframe: label,
          });
        }

        await prisma.reminder.update({
          where: { id: reminder.id },
          data: { status: 'SENT', sentAt: new Date(), attempts: { increment: 1 } },
        });
      } catch (err) {
        const attempts = reminder.attempts + 1;
        await prisma.reminder.update({
          where: { id: reminder.id },
          data: {
            attempts,
            status: attempts >= 3 ? 'FAILED' : 'PENDING',
            error: (err as Error).message.slice(0, 500),
          },
        });
        console.error(`[scheduler] ${reminder.kind} to ${sc.candidate.email} failed:`, (err as Error).message);
      }
    }
  }

  /** Flips SCHEDULED sessions to ACTIVE once their start time arrives. */
  private static async activateDueSessions() {
    const { count } = await prisma.interviewSession.updateMany({
      where: { status: 'SCHEDULED', scheduledAt: { lte: new Date() } },
      data: { status: 'ACTIVE' },
    });
    if (count) console.log(`[scheduler] activated ${count} session(s)`);
  }

  /**
   * Nudges candidates who are late but still inside the grace window.
   *
   * The live state machine only nudges candidates who actually opened the room,
   * so without this a candidate who never clicked their link would be marked
   * absent having heard nothing since the invitation. Fires once per candidate,
   * enforced by the unique (sessionCandidate, kind) reminder row.
   */
  private static async sendNoShowNudges() {
    const now = Date.now();
    // Halfway through the grace period: late enough to be meaningful, early
    // enough that they can still make it.
    const nudgeAfter = new Date(now - (env.NO_SHOW_GRACE_MINUTES / 2) * 60_000);
    const graceCutoff = new Date(now - env.NO_SHOW_GRACE_MINUTES * 60_000);

    const late = await prisma.sessionCandidate.findMany({
      where: {
        status: 'INVITED',
        joinedAt: null,
        interviewSession: {
          status: { in: ['ACTIVE', 'SCHEDULED'] },
          // Past the nudge point but not yet past the absent cutoff.
          scheduledAt: { lte: nudgeAfter, gt: graceCutoff },
        },
        reminders: { none: { kind: 'NO_SHOW_NUDGE' } },
      },
      include: { candidate: true, interviewSession: true, meetBotRun: true },
      take: 50,
    });

    for (const sc of late) {
      try {
        await emailService.sendNoShowNudge({
          to: sc.candidate.email,
          name: sc.candidate.name,
          role: sc.interviewSession.title,
          joinUrl: joinUrlFor(sc),
        });

        await prisma.reminder.create({
          data: {
            sessionCandidateId: sc.id,
            kind: 'NO_SHOW_NUDGE',
            status: 'SENT',
            scheduledFor: new Date(),
            sentAt: new Date(),
          },
        });

        console.log(`[scheduler] nudged ${sc.candidate.email} — interview started without them`);
      } catch (err) {
        // Record the attempt either way so a broken mailbox is not retried forever.
        await prisma.reminder
          .create({
            data: {
              sessionCandidateId: sc.id,
              kind: 'NO_SHOW_NUDGE',
              status: 'FAILED',
              scheduledFor: new Date(),
              attempts: 1,
              error: (err as Error).message.slice(0, 500),
            },
          })
          .catch(() => {});
        console.error(`[scheduler] no-show nudge to ${sc.candidate.email} failed:`, (err as Error).message);
      }
    }
  }

  /**
   * Marks candidates absent once the grace period after the scheduled start
   * has elapsed without them joining. This is the safety net for candidates who
   * never opened the link at all — the live state machine handles the case
   * where a room was opened but nobody arrived.
   */
  private static async markNoShows() {
    const cutoff = new Date(Date.now() - env.NO_SHOW_GRACE_MINUTES * 60_000);
    // A meeting interview is not late until the bot itself gives up, which it
    // does on its own clock — the primary wait plus the grace window. Writing
    // the candidate off here would end an interview that is still sitting in
    // the meeting waiting for them.
    const meetBotStillWaiting = new Date(
      Date.now() - (env.MEET_BOT_CANDIDATE_WAIT_MINUTES + env.MEET_BOT_CANDIDATE_GRACE_MINUTES) * 60_000,
    );

    const stragglers = await prisma.sessionCandidate.findMany({
      where: {
        status: 'INVITED',
        joinedAt: null,
        interviewSession: { scheduledAt: { lte: cutoff }, status: { in: ['ACTIVE', 'SCHEDULED'] } },
        OR: [
          { meetBotRun: { is: null } },
          { interviewSession: { scheduledAt: { lte: meetBotStillWaiting } } },
        ],
      },
      select: { id: true },
      take: 100,
    });

    if (!stragglers.length) return;

    await prisma.sessionCandidate.updateMany({
      where: { id: { in: stragglers.map((s) => s.id) } },
      data: { status: 'ABSENT', absentAt: new Date() },
    });
    console.log(`[scheduler] marked ${stragglers.length} candidate(s) absent`);
  }

  /** Closes sessions where every candidate has reached a terminal state. */
  private static async closeFinishedSessions() {
    const active = await prisma.interviewSession.findMany({
      where: { status: 'ACTIVE' },
      include: { candidates: { select: { status: true } } },
    });

    const done = active.filter(
      (s) =>
        s.candidates.length > 0 &&
        s.candidates.every((c) => ['COMPLETED', 'ABSENT', 'CANCELLED'].includes(c.status)),
    );

    if (!done.length) return;

    await prisma.interviewSession.updateMany({
      where: { id: { in: done.map((s) => s.id) } },
      data: { status: 'COMPLETED' },
    });
  }
}
