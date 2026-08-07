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

/** Deepgram's live transcription endpoint. */
function socketUrl(language: string): string {
  const params = new URLSearchParams({
    model: 'nova-2',
    // Deepgram wants "en", "hi", "es"; our sessions carry locales like "en-IN".
    language: language.split('-')[0] ?? 'en',
    punctuate: 'true',
    smart_format: 'true',
    interim_results: 'true',
    // Let Deepgram decide when a turn is over rather than a fixed client timer.
    endpointing: '800',
    utterance_end_ms: '3000',
    vad_events: 'true',
  });

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
  ) {
    super();
  }

  start() {
    if (!deepgramConfigured) {
      this.emit('error', new Error('Deepgram is not configured'));
      return;
    }

    const socket = new WebSocket(socketUrl(this.language), {
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
