import jwt from 'jsonwebtoken';
import type { Server, Socket } from 'socket.io';
import type { AuthUser } from '../lib/auth';
import { env } from '../lib/env';
import { prisma } from '../lib/prisma';
import { MeetBotManager, type BotEventName } from '../services/meetingBot/MeetBotManager';

/**
 * The recruiter's live window onto a running Google Meet interview.
 *
 * Read-only by design: this namespace reports what the bot is doing and never
 * accepts instructions. Starting and stopping go through the authenticated REST
 * endpoints, where ownership is checked properly and the action is recorded.
 */

/** What clients subscribe to. One room per interview. */
const room = (interviewId: string) => `interview:${interviewId}`;

/** Maps a session event to the wire event name. */
const WIRE_EVENT: Record<BotEventName, string> = {
  status: 'interview:status',
  joined: 'interview:joined',
  message: 'interview:message',
  question: 'interview:question',
  answer: 'interview:answer',
  interim: 'interview:interim',
  completed: 'interview:completed',
  error: 'interview:error',
};

/**
 * The last stretch of each running interview, replayed to a recruiter who opens
 * the page late. Without it they would see a blank panel until the next thing
 * happens, which during a thoughtful answer can be a minute of nothing.
 */
const RECENT_LIMIT = 60;
const recent = new Map<string, Array<{ event: string; payload: unknown }>>();

function remember(interviewId: string, event: string, payload: unknown): void {
  // Interim transcripts are superseded within a second; replaying them would
  // show stale half-sentences.
  if (event === 'interview:interim') return;

  const buffer = recent.get(interviewId) ?? [];
  buffer.push({ event, payload });
  if (buffer.length > RECENT_LIMIT) buffer.shift();
  recent.set(interviewId, buffer);
}

export function configureMeetBotGateway(io: Server) {
  const nsp = io.of('/meet-bot');

  // Only signed-in recruiters. The candidate is in the meeting itself and has
  // no reason to watch the machinery.
  nsp.use((socket, next) => {
    const token = String(socket.handshake.auth?.token ?? socket.handshake.query?.token ?? '');
    if (!token) return next(new Error('Authentication required'));

    try {
      socket.data.user = jwt.verify(token, env.JWT_SECRET) as AuthUser;
      next();
    } catch {
      next(new Error('Invalid or expired token'));
    }
  });

  nsp.on('connection', (socket: Socket) => {
    socket.on('subscribe', async (payload: { interviewId?: string }, ack?: (result: unknown) => void) => {
      const interviewId = String(payload?.interviewId ?? '');
      if (!interviewId) return ack?.({ ok: false, error: 'interviewId is required' });

      const user = socket.data.user as AuthUser;

      // A recruiter may only watch interviews from their own sessions.
      const owned = await prisma.sessionCandidate.findFirst({
        where: { id: interviewId, interviewSession: { userId: user.userId } },
        select: { id: true, meetBotRun: { select: { status: true, statusDetail: true, errorMessage: true } } },
      });

      if (!owned) return ack?.({ ok: false, error: 'Interview not found' });

      await socket.join(room(interviewId));

      // Current state first, then whatever has happened recently, so the panel
      // is populated the instant it opens.
      socket.emit('interview:status', {
        interviewId,
        status: MeetBotManager.statusOf(interviewId) ?? owned.meetBotRun?.status ?? 'SCHEDULED',
        detail: owned.meetBotRun?.statusDetail ?? null,
      });

      for (const item of recent.get(interviewId) ?? []) {
        socket.emit(item.event, item.payload);
      }

      ack?.({ ok: true });
    });

    socket.on('unsubscribe', (payload: { interviewId?: string }) => {
      const interviewId = String(payload?.interviewId ?? '');
      if (interviewId) void socket.leave(room(interviewId));
    });
  });

  // Everything the bots emit flows through here.
  MeetBotManager.setEventSink((interviewId, event, payload) => {
    const wire = WIRE_EVENT[event];
    if (!wire) return;

    const body = { interviewId, ...(payload as Record<string, unknown>) };

    remember(interviewId, wire, body);
    nsp.to(room(interviewId)).emit(wire, body);

    // `interview:started` is a distinct moment recruiters watch for, and it is
    // not something the session emits — it is the first status after launch.
    if (event === 'status' && (payload as { status?: string })?.status === 'STARTING') {
      remember(interviewId, 'interview:started', body);
      nsp.to(room(interviewId)).emit('interview:started', body);
    }

    if (event === 'completed' || (event === 'status' && isTerminal((payload as { status?: string })?.status))) {
      // The interview is over; the buffer is only useful while it is live.
      setTimeout(() => recent.delete(interviewId), 60_000);
    }
  });

  return nsp;
}

const isTerminal = (status?: string) =>
  status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED';
