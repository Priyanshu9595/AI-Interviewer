import { Server, Socket } from 'socket.io';
import { prisma } from '../lib/prisma';
import { EvaluationQueue } from '../services/EvaluationQueue';
import { InterviewStateMachine } from '../services/InterviewStateMachine';
import { evaluateJoinGate } from '../services/JoinGate';
import { InsightService } from '../services/InsightService';
import { RecordingService } from '../services/RecordingService';
import { SpeechSession, SpeechResult, deepgramConfigured } from '../services/SpeechService';

interface Room {
  machine: InterviewStateMachine;
  /** Sockets currently attached: the candidate plus any observing recruiters. */
  sockets: Set<string>;
  disconnectTimer: NodeJS.Timeout | null;
  /** Live Deepgram session, created on the first audio chunk. */
  speech: SpeechSession | null;
  /** When the candidate's current turn began, for latency measurement. */
  turnStartedAt: number;
  /**
   * Whether speech heard right now counts as an answer. Audio streams
   * continuously, so this — not muting — is what stops the interviewer's own
   * voice being transcribed back as the candidate's reply.
   */
  acceptingAnswers: boolean;
  roomId: string;
  /** Interview language, used for the transcription model. */
  language: string;
}

const rooms = new Map<string, Room>();

/** Reconnection window before a dropped candidate counts as having left. */
const RECONNECT_GRACE_MS = 45_000;

type Nsp = ReturnType<Server['of']>;

export function configureInterviewGateway(io: Server) {
  const nsp = io.of('/interview');

  nsp.on('connection', (socket: Socket) => {
    const token = String(socket.handshake.query.token ?? '');
    console.log(`[gateway] socket ${socket.id} connecting (token ${token.slice(0, 8)}…)`);

    if (!token) {
      socket.emit('error_message', { message: 'Missing interview token' });
      socket.disconnect(true);
      return;
    }

    /**
     * Resolving the token needs a database round-trip, but the client may emit
     * `candidate_joined` the instant it connects. Socket.IO drops events that
     * arrive before a listener exists, so every listener is registered
     * synchronously here and each one awaits this promise before acting.
     */
    const roomReady = openRoom(nsp, socket, token);

    // Surface a failed handshake instead of leaving the candidate in silence.
    roomReady.catch((err) => {
      console.error('[gateway] could not open the room:', err);
      socket.emit('error_message', { message: 'Could not start the interview. Please reload the page.' });
      socket.disconnect(true);
    });

    /** Runs `fn` once the room exists; ignores sockets whose handshake failed. */
    const withRoom = (fn: (room: Room) => void | Promise<void>) => {
      void roomReady
        .then((room) => (room ? fn(room) : undefined))
        .catch((err) => console.error('[gateway] handler failed:', err));
    };

    socket.on('candidate_joined', () =>
      withRoom((room) =>
        room.machine.candidateJoined().catch((err) => {
          console.error('[gateway] join failed:', err);
          socket.emit('error_message', { message: 'Could not start the interview. Please reload the page.' });
        }),
      ),
    );

    socket.on(
      'candidate_answer',
      (payload: { text?: string; latencyMs?: number; durationMs?: number; confidence?: number }) => {
        const text = String(payload?.text ?? '').trim();
        if (!text) return;

        withRoom((room) =>
          room.machine.candidateAnswered({
            text,
            latencyMs: payload.latencyMs,
            durationMs: payload.durationMs,
            confidence: payload.confidence,
          }),
        );
      },
    );

    socket.on('candidate_doubt', (payload: { text?: string }) => {
      const text = String(payload?.text ?? '').trim();
      if (text) withRoom((room) => room.machine.candidateAskedDoubt(text));
    });

    socket.on('silence_timeout', () => withRoom((room) => room.machine.silenceDetected()));

    socket.on('coding_submitted', (payload: { passed?: number; total?: number }) =>
      withRoom((room) =>
        room.machine.codingSubmitted({
          passed: Number(payload?.passed ?? 0),
          total: Number(payload?.total ?? 0),
        }),
      ),
    );

    // --- Server-side speech to text ---------------------------------------

    socket.on('audio_chunk', (chunk: ArrayBuffer | Buffer) => {
      withRoom((room) => {
        if (!deepgramConfigured) return;

        room.speech ??= createSpeechSession(nsp, room);
        room.speech.send(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
    });

    socket.on('listening_started', () =>
      withRoom((room) => {
        room.acceptingAnswers = true;
        room.turnStartedAt = Date.now();
      }),
    );

    socket.on('listening_stopped', () => withRoom((room) => void (room.acceptingAnswers = false)));

    /** Proctoring: the candidate left the tab, or tried to copy or paste. */
    socket.on('proctoring_event', (payload: { type?: string; detail?: string; awayMs?: number }) =>
      withRoom(async (room) => {
        const type = String(payload?.type ?? 'UNKNOWN');
        const detail = String(payload?.detail ?? '').slice(0, 200);
        const awayMs = Number(payload?.awayMs ?? 0);

        // A long absence is more suspicious than a brief one.
        const severity = type === 'TAB_SWITCH' ? Math.min(1, 0.4 + awayMs / 60_000) : 0.5;

        await InsightService.record(room.roomId, [
          { type: 'OFF_TOPIC', message: `Proctoring: ${detail}`, severity, meta: { proctoring: type, awayMs } },
        ]).catch(() => {});

        nsp.to(room.roomId).emit('insight', { type: 'PROCTORING', message: detail, severity });
      }),
    );

    socket.on('end_interview', () => withRoom((room) => room.machine.candidateLeft()));

    socket.on('disconnect', () =>
      withRoom((room) => {
        room.sockets.delete(socket.id);
        if (room.sockets.size > 0) return;

        // Everyone dropped. Allow a window to come back before ending.
        room.disconnectTimer = setTimeout(() => {
          if (room.sockets.size > 0) return;
          void room.machine.candidateLeft();
        }, RECONNECT_GRACE_MS);
      }),
    );
  });

  return nsp;
}

/**
 * Resolves the access token, joins the socket to its room, and creates the
 * state machine on first connection. Returns null when the interview is not
 * joinable, in which case the socket has already been told why.
 */
async function openRoom(nsp: Nsp, socket: Socket, token: string): Promise<Room | null> {
  const sc = await prisma.sessionCandidate.findUnique({
    where: { accessToken: token },
    include: { interviewSession: true, candidate: { select: { name: true } } },
  });

  if (!sc) {
    socket.emit('error_message', { message: 'This interview link is not valid' });
    socket.disconnect(true);
    return null;
  }

  // The same gate the HTTP endpoint applies. Enforced here too, because the
  // socket is reachable directly and the HTTP check alone would be advisory.
  const gate = evaluateJoinGate({
    scheduledAt: sc.interviewSession.scheduledAt,
    sessionStatus: sc.interviewSession.status,
    candidateStatus: sc.status,
    joinedAt: sc.joinedAt,
  });

  if (!gate.canJoin) {
    console.log(`[gateway] refused ${sc.id}: ${gate.verdict}`);
    socket.emit('interview_closed', { verdict: gate.verdict, reason: gate.reason });
    socket.emit('error_message', { message: gate.reason ?? 'This interview is not open.' });
    socket.disconnect(true);
    return null;
  }

  const roomId = sc.id;
  socket.join(roomId);

  let room = rooms.get(roomId);

  if (!room) {
    const machine = new InterviewStateMachine(roomId);
    room = {
      machine,
      sockets: new Set(),
      disconnectTimer: null,
      speech: null,
      turnStartedAt: Date.now(),
      acceptingAnswers: false,
      roomId,
      language: sc.interviewSession.language,
    };
    rooms.set(roomId, room);
    wireMachine(nsp, roomId, machine);
  } else if (room.disconnectTimer) {
    // The candidate came back inside the grace window.
    clearTimeout(room.disconnectTimer);
    room.disconnectTimer = null;
  }

  room.sockets.add(socket.id);

  socket.emit('connected', {
    sessionCandidateId: sc.id,
    state: room.machine.state,
    candidateName: sc.candidate?.name,
  });

  return room;
}

/**
 * Opens a Deepgram session for a room and turns its transcripts into interview
 * answers.
 *
 * Deepgram's own end-of-speech signal decides when a turn is complete, which is
 * more reliable than the browser's fixed silence timer — it accounts for a
 * candidate pausing mid-sentence to think.
 */
function createSpeechSession(nsp: Nsp, room: Room): SpeechSession {
  const session = new SpeechSession(room.roomId, room.language);
  let pending = '';
  let confidenceSum = 0;
  let finalCount = 0;

  session.on('transcript', (result: SpeechResult) => {
    if (!result.isFinal) {
      // Show the candidate what is being heard as they speak.
      nsp.to(room.roomId).emit('interim_transcript', { text: result.text });
      return;
    }

    pending = `${pending} ${result.text}`.trim();
    confidenceSum += result.confidence;
    finalCount++;

    if (!result.speechFinal) return;
    flush();
  });

  // Deepgram's utterance boundary is the backstop when speech_final never comes.
  session.on('utteranceEnd', flush);

  function flush() {
    const text = pending.trim();
    if (!text) return;

    if (!room.acceptingAnswers) {
      // Heard while the interviewer was speaking or thinking — most likely the
      // AI's own voice through the candidate's speakers. Discard it.
      pending = '';
      confidenceSum = 0;
      finalCount = 0;
      return;
    }

    const confidence = finalCount ? confidenceSum / finalCount : 0.9;
    const now = Date.now();

    pending = '';
    confidenceSum = 0;
    finalCount = 0;

    nsp.to(room.roomId).emit('final_transcript', { text });

    void room.machine.candidateAnswered({
      text,
      confidence,
      latencyMs: Math.max(0, room.turnStartedAt ? now - room.turnStartedAt : 0),
      durationMs: 0,
    });

    room.turnStartedAt = now;
  }

  session.on('error', () => {
    // Tell the client to fall back to browser recognition rather than sitting mute.
    nsp.to(room.roomId).emit('speech_unavailable', {});
  });

  session.start();
  return session;
}

function wireMachine(nsp: Nsp, roomId: string, machine: InterviewStateMachine) {
  machine.on('say', (data) => nsp.to(roomId).emit('ai_speak', data));
  machine.on('state', (data) => nsp.to(roomId).emit('state_change', data));
  machine.on('insight', (data) => nsp.to(roomId).emit('insight', data));
  machine.on('coding', (data) => nsp.to(roomId).emit('coding_challenge', data));
  machine.on('thinking', (data) => nsp.to(roomId).emit('ai_thinking', data));

  machine.on('ended', (data: { reason: string }) => {
    nsp.to(roomId).emit('interview_ended', data);

    const room = rooms.get(roomId);
    if (room?.disconnectTimer) clearTimeout(room.disconnectTimer);
    room?.speech?.stop();
    rooms.delete(roomId);
    machine.dispose();

    // Save whatever was streamed, even when the candidate closed the tab and
    // will never send a finalise request of its own. Delayed slightly so any
    // in-flight chunk lands first.
    setTimeout(() => {
      void RecordingService.finalise(roomId)
        .then((r) => {
          if (!r.stored && r.reason !== 'recording is disabled for this session') {
            console.log(`[recording] nothing stored for ${roomId}: ${r.reason}`);
          }
        })
        .catch((err) => console.error(`[recording] finalise failed for ${roomId}:`, err.message));
    }, 4000);

    // Only a full interview is scored. A no-show has nothing to evaluate, and
    // an abandoned one cannot be judged fairly against candidates who finished.
    // Failures are recorded and retried by the scheduler rather than lost.
    if (data.reason === 'completed' || data.reason === 'ended_early') {
      void EvaluationQueue.run(roomId).then((ok) => {
        if (ok) nsp.to(roomId).emit('report_ready', { sessionCandidateId: roomId });
      });
    }
  });
}

export const activeInterviewCount = () => rooms.size;
