import type { Server, Socket } from 'socket.io';
import { prisma } from '../lib/prisma';

/**
 * Mirrors the candidate's code editor into the meeting.
 *
 * A meeting call has no shared editor, so the candidate writes in their own
 * browser tab. That leaves everyone else — the interviewer, and any human
 * watching — unable to see the work as it happens, which is most of the value
 * of a live coding round.
 *
 * So the editor broadcasts what it holds, and a read-only spectator page renders
 * it. The bot opens that page in a second tab and presents it into the meeting,
 * which puts the candidate's code on screen for everyone without giving anyone
 * else the ability to type in it.
 *
 * The room key is the interview. The access token is the credential — the same
 * one that opens the editor — so nothing new has to be issued or remembered.
 */

const room = (sessionCandidateId: string) => `code:${sessionCandidateId}`;

/** The most recent state per interview, so a spectator joining late sees code. */
interface MirrorState {
  code: string;
  language: string;
  questionId: string | null;
  submitted: { passed: number; total: number } | null;
  updatedAt: number;
}

const latest = new Map<string, MirrorState>();

/** Nothing here is a record; the transcript and submissions are. */
const STALE_MS = 6 * 60 * 60_000;

function prune(): void {
  const cutoff = Date.now() - STALE_MS;
  for (const [key, state] of latest) {
    if (state.updatedAt < cutoff) latest.delete(key);
  }
}

export function configureCodingGateway(io: Server) {
  const nsp = io.of('/coding');

  nsp.on('connection', (socket: Socket) => {
    let interviewId: string | null = null;

    socket.on('join', async (payload: { token?: string }, ack?: (result: unknown) => void) => {
      const token = String(payload?.token ?? '');
      if (!token) return ack?.({ ok: false, error: 'A token is required' });

      // Without this the client is left waiting on an ack that never comes:
      // a database blip would hang the editor with nothing on screen to say so.
      let sc;
      try {
        sc = await prisma.sessionCandidate.findUnique({
          where: { accessToken: token },
          select: { id: true, candidate: { select: { name: true } }, interviewSession: { select: { title: true } } },
        });
      } catch (err) {
        console.error('[coding] could not look up the interview:', err);
        return ack?.({ ok: false, error: 'The editor could not be reached. Please try again.' });
      }

      if (!sc) return ack?.({ ok: false, error: 'This link is not valid' });

      interviewId = sc.id;
      await socket.join(room(sc.id));

      // Whatever has been typed so far, so a spectator that connects halfway
      // through does not stare at an empty editor.
      const state = latest.get(sc.id);

      ack?.({
        ok: true,
        candidateName: sc.candidate.name,
        jobTitle: sc.interviewSession.title,
        state: state ?? null,
      });
    });

    socket.on('code:update', (payload: { code?: string; language?: string; questionId?: string }) => {
      if (!interviewId) return;

      const state: MirrorState = {
        // Bounded: a runaway paste must not be broadcast or held in memory.
        code: String(payload?.code ?? '').slice(0, 60_000),
        language: String(payload?.language ?? 'javascript'),
        questionId: payload?.questionId ?? null,
        submitted: latest.get(interviewId)?.submitted ?? null,
        updatedAt: Date.now(),
      };

      latest.set(interviewId, state);
      socket.to(room(interviewId)).emit('code:update', state);
      prune();
    });

    socket.on('code:submitted', (payload: { passed?: number; total?: number }) => {
      if (!interviewId) return;

      const summary = { passed: Number(payload?.passed ?? 0), total: Number(payload?.total ?? 0) };
      const state = latest.get(interviewId);
      if (state) state.submitted = summary;

      nsp.to(room(interviewId)).emit('code:submitted', summary);
    });

    socket.on('code:running', () => {
      if (interviewId) socket.to(room(interviewId)).emit('code:running', {});
    });
  });

  return nsp;
}
