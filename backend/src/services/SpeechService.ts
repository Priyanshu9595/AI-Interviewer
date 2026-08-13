import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { env } from '../lib/env';

export const deepgramConfigured = Boolean(env.DEEPGRAM_API_KEY);

export interface SpeechResult {
  text: string;
  confidence: number;
  /** Deepgram has settled on this text; it will not be revised. */
  isFinal: boolean;
  /** Deepgram believes the speaker has finished their turn. */
  speechFinal: boolean;
}

/**
 * How the audio being streamed is encoded.
 *
 * The browser sends a WebM/Opus container, which Deepgram sniffs on its own.
 * The Google Meet bot taps WebRTC tracks and produces bare PCM, which has no
 * header to sniff — the rate and encoding have to be declared up front.
 */
export interface AudioFormat {
  encoding: 'linear16';
  sampleRate: number;
  channels?: number;
}

/**
 * Terms worth telling Deepgram to expect.
 *
 * A general model hears "Cuban Eddie's" for Kubernetes and "jangle rest" for
 * Angular REST, and in a technical interview those are precisely the words the
 * answer turns on. The skills the recruiter listed are the best available
 * guess at what will be said, and prompting them costs nothing. This matters
 * doubly in Hindi or Telugu interviews, where candidates code-switch and the
 * technical terms stay English.
 *
 * Capped and length-filtered: Deepgram takes a bounded list, and a one or two
 * character "skill" boosts noise rather than a word.
 */
function keywordParams(params: URLSearchParams, skills: string[] = []): void {
  const terms = skills
    .map((s) => s.trim())
    .filter((s) => s.length > 2 && s.length <= 40)
    .slice(0, 25);

  // nova-3 replaced weighted `keywords` with keyterm prompting; sending the
  // old parameter to it is rejected outright.
  for (const term of terms) params.append('keyterm', term);
}

/** Deepgram's live transcription endpoint. */
function socketUrl(language: string, format?: AudioFormat, skills?: string[]): string {
  const params = new URLSearchParams({
    // nova-3, because its language list is what decides which languages an
    // interview can be held in at all: nova-2 never learned Telugu, Tamil,
    // Bengali or Marathi, and every language this platform offers is on
    // nova-3's list.
    model: 'nova-3',
    // Deepgram wants "en", "hi", "te"; our sessions carry locales like "te-IN".
    language: language.split('-')[0] ?? 'en',
    punctuate: 'true',
    smart_format: 'true',
    interim_results: 'true',
    // Let Deepgram decide when a turn is over rather than a fixed client timer.
    endpointing: '800',
    utterance_end_ms: '3000',
    vad_events: 'true',
  });

  if (format) {
    params.set('encoding', format.encoding);
    params.set('sample_rate', String(format.sampleRate));
    params.set('channels', String(format.channels ?? 1));
  }

  keywordParams(params, skills);

  return `wss://api.deepgram.com/v1/listen?${params}`;
}

/**
 * A live transcription session for one candidate.
 *
 * Audio is relayed through this server rather than sent to Deepgram from the
 * browser. A browser-side key is trivially extractable from the network tab,
 * and this account's key cannot mint short-lived keys, so proxying is both the
 * safer and the only workable option.
 */
export class SpeechSession extends EventEmitter {
  private socket: WebSocket | null = null;
  private open = false;
  /** Audio arriving before the socket opens, replayed once it does. */
  private backlog: Buffer[] = [];
  private keepAlive: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private readonly sessionCandidateId: string,
    private readonly language: string,
    /** Omit for container formats Deepgram can identify by itself. */
    private readonly format?: AudioFormat,
    /** The role's required skills, boosted so they are heard correctly. */
    private readonly skills?: string[],
  ) {
    super();
  }

  start() {
    if (!deepgramConfigured) {
      this.emit('error', new Error('Deepgram is not configured'));
      return;
    }

    const socket = new WebSocket(socketUrl(this.language, this.format, this.skills), {
      headers: { Authorization: `Token ${env.DEEPGRAM_API_KEY}` },
    });
    this.socket = socket;

    socket.on('open', () => {
      this.open = true;

      for (const chunk of this.backlog) socket.send(chunk);
      this.backlog = [];

      // Deepgram closes idle sockets, and a candidate thinking in silence is
      // idle. KeepAlive holds the connection through those pauses.
      this.keepAlive = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'KeepAlive' }));
        }
      }, 8000);

      this.emit('ready');
    });

    socket.on('message', (raw: WebSocket.RawData) => {
      let payload: {
        type?: string;
        is_final?: boolean;
        speech_final?: boolean;
        channel?: { alternatives?: Array<{ transcript?: string; confidence?: number }> };
      };

      try {
        payload = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (payload.type === 'UtteranceEnd') {
        this.emit('utteranceEnd');
        return;
      }

      const alt = payload.channel?.alternatives?.[0];
      const text = alt?.transcript?.trim();
      if (!text) return;

      this.emit('transcript', {
        text,
        confidence: alt?.confidence ?? 0.9,
        isFinal: Boolean(payload.is_final),
        speechFinal: Boolean(payload.speech_final),
      } satisfies SpeechResult);
    });

    socket.on('error', (err) => {
      console.error(`[speech] Deepgram error for ${this.sessionCandidateId}:`, err.message);
      this.emit('error', err);
    });

    socket.on('close', (code, reason) => {
      this.open = false;
      if (!this.closed) {
        console.log(`[speech] Deepgram closed for ${this.sessionCandidateId}: ${code} ${reason.toString()}`);
        this.emit('closed');
      }
    });
  }

  /** Feeds one chunk of candidate audio. */
  send(chunk: Buffer) {
    if (this.closed) return;

    if (!this.open) {
      // Bound the backlog so a socket that never opens cannot grow unbounded.
      if (this.backlog.length < 200) this.backlog.push(chunk);
      return;
    }

    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(chunk);
  }

  stop() {
    this.closed = true;
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
    this.backlog = [];

    if (this.socket?.readyState === WebSocket.OPEN) {
      // Asks Deepgram to flush any buffered audio before hanging up.
      this.socket.send(JSON.stringify({ type: 'CloseStream' }));
      setTimeout(() => this.socket?.close(), 500);
    } else {
      this.socket?.close();
    }

    this.socket = null;
    this.removeAllListeners();
  }
}

export type SpeechStatus = 'disabled' | 'ok' | 'unreachable';

let speechStatus: SpeechStatus = deepgramConfigured ? 'unreachable' : 'disabled';
export const getSpeechStatus = () => speechStatus;

/** Confirms at boot that Deepgram will accept our key. */
export async function verifySpeech(): Promise<SpeechStatus> {
  if (!deepgramConfigured) {
    console.log('[speech] Deepgram not configured — the browser will transcribe instead');
    speechStatus = 'disabled';
    return speechStatus;
  }

  try {
    const res = await fetch('https://api.deepgram.com/v1/projects', {
      headers: { Authorization: `Token ${env.DEEPGRAM_API_KEY}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);

    speechStatus = 'ok';
    console.log('[speech] Deepgram ready — candidate audio is transcribed server-side');
  } catch (err) {
    speechStatus = 'unreachable';
    console.error('[speech] Deepgram unreachable, browser recognition will be used:', (err as Error).message);
  }

  return speechStatus;
}
