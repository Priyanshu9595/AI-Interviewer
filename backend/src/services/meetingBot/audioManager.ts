import { EventEmitter } from 'events';
import type { Page } from 'playwright';
import { AnswerSettler, type SettledAnswer } from '../AnswerSettler';
import { SpeechSession, type SpeechResult, deepgramConfigured, isLikelyNoise } from '../SpeechService';
import { BotError } from './errors';
import { audioBridgeScript } from './injected/audioBridge';
import { createTtsDriver, type BridgeStatus, type MeetBotWindow, type TtsDriver } from './tts';

/**
 * Owns both directions of audio for one meeting, and keeps them apart.
 *
 * inputAudio  — remote WebRTC tracks, tapped in the page, downsampled to
 *               16 kHz PCM, streamed to Deepgram, surfaced as `transcript`.
 * outputAudio — text handed to a TTS driver and written into the synthetic
 *               microphone Google Meet is holding.
 *
 * The one place they meet is the listening gate. While the interviewer is
 * speaking, transcripts are dropped rather than treated as an answer: the
 * candidate's own microphone will pick the AI's voice up out of their speakers,
 * and without the gate the interview would answer itself.
 */

export interface AudioManagerEvents {
  /** A complete candidate utterance, ready to be treated as an answer. */
  transcript: { text: string; confidence: number; latencyMs: number };
  /** Partial text, for the recruiter's live view only. */
  interim: { text: string };
  /** Speech-to-text became unusable; the interview cannot continue deaf. */
  speechFailed: BotError;
  /** No meeting audio reached the bot at all, on any tap. */
  deaf: BridgeStatus | null;
}

/**
 * Sent at the rate the meeting arrives at, rather than downsampled first.
 *
 * This used to be 16 kHz, on the reasoning that it is Deepgram's native rate
 * for speech and a third of the bytes. The bytes were true; the quality was
 * not. Getting from the browser's 48 kHz to 16 kHz meant averaging every three
 * samples, and a three-tap box filter is a poor anti-alias filter — around 4 dB
 * down at the new Nyquist, so everything above 8 kHz folded back into the
 * speech band as noise. Sibilants suffered most, which is exactly what makes a
 * transcript full of near-miss words.
 *
 * Deepgram resamples internally with a filter built for the job, so handing it
 * the original 48 kHz is both simpler and better. It costs three times the
 * bandwidth to Deepgram — about 170 MB for a half-hour interview — and nothing
 * else.
 */
const CAPTURE_SAMPLE_RATE = 48_000;
const CAPTURE_FRAME_MS = 250;

/**
 * Silence held after the AI stops talking before answers are accepted again.
 *
 * Covers the tail of the candidate's speakers and the room's reverb. Too short
 * and the interviewer transcribes its own last syllable as the answer; too long
 * and it clips a candidate who replies immediately.
 */
const LISTEN_RESUME_DELAY_MS = 600;

/**
 * How long the WebRTC tap gets before the fallback taps are switched on.
 *
 * On Google Meet and Teams remote audio arrives within a second or two of
 * joining, so a silence this long means this client does not publish remote
 * audio as a track at all — Zoom's WebAssembly path being the case in point.
 */
const CAPTURE_FALLBACK_MS = 12_000;

/** A second, louder warning if even the fallbacks find nothing. */
const CAPTURE_DEAF_MS = 40_000;

/**
 * Silence held after the recogniser calls a turn over, before the answer counts
 * as finished. See AnswerSettler for why. The cost is three seconds before
 * every reply, which is the trade for not talking over the candidate.
 */
const ANSWER_SETTLE_MS = 3_000;

/**
 * Frame level that counts as somebody speaking, as a fraction of full scale.
 *
 * About -40 dBFS. A quiet room with an open microphone sits well below it;
 * conversational speech over a meeting sits an order of magnitude above. Only
 * used to decide whether anyone is present — never to gate an answer, which is
 * the bridge's job.
 */
const SPEECH_RMS = 0.01;

/** Root-mean-square level of one 16-bit PCM frame, 0..1. */
function frameRms(chunk: Buffer): number {
  const samples = Math.floor(chunk.length / 2);
  if (!samples) return 0;

  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const s = chunk.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / samples);
}

export class AudioManager extends EventEmitter {
  private speech: SpeechSession | null = null;
  private readonly tts: TtsDriver;

  /** Whether speech heard right now counts as the candidate's answer. */
  private accepting = false;
  private resumeTimer: NodeJS.Timeout | null = null;

  /** Joins Deepgram's pieces into one utterance and holds it open to settle. */
  private readonly settler: AnswerSettler;

  /** When the candidate's current turn began, for the hesitation signal. */
  private turnStartedAt = Date.now();

  private installed = false;
  private disposed = false;
  private speaking = false;
  private audioSeen = false;
  private heardSound = false;
  /** Consecutive frames at speech level, before anyone has been heard. */
  private loudFrames = 0;
  private captureTimers: NodeJS.Timeout[] = [];

  constructor(
    private readonly page: Page,
    private readonly opts: { interviewId: string; language: string; skills?: string[] },
  ) {
    super();
    this.tts = createTtsDriver();
    this.settler = new AnswerSettler(ANSWER_SETTLE_MS, (answer) => this.submit(answer));
  }

  get ttsDriver(): TtsDriver {
    return this.tts;
  }

  /** True while the interviewer's voice is still being heard in the meeting. */
  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** Whether any remote audio has ever arrived — proof the tap is working. */
  get hasHeardAudio(): boolean {
    return this.audioSeen;
  }

  /**
   * Whether actual sound, rather than silence, has come out of the meeting.
   *
   * This is the most dependable evidence that somebody else is present.
   * Counting participants means reading the client's own interface, and when
   * those selectors drift the bot concludes it is alone in a room it can
   * plainly hear — which is how an interview was scored a no-show while the
   * candidate sat in it for seven minutes.
   */
  get hasHeardSomeoneSpeak(): boolean {
    return this.heardSound;
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  /**
   * Installs the bridge. Must run before the Meet page is navigated to: the
   * `getUserMedia` and `RTCPeerConnection` overrides have to be in place before
   * Meet's own bundle captures references to the originals.
   */
  async install(): Promise<void> {
    if (this.installed) return;

    await this.tts.verify();

    if (!deepgramConfigured) {
      throw new BotError(
        'SPEECH_TO_TEXT_UNAVAILABLE',
        'DEEPGRAM_API_KEY is not set. The Meet bot has no browser to fall back to, so it cannot hear the candidate without it.',
      );
    }

    await this.page.exposeBinding('__meetBotAudio', (_source, base64: string) => {
      this.onAudioFrame(base64);
    });

    await this.page.exposeBinding('__meetBotEvent', (_source, payload: string) => {
      this.onBridgeEvent(payload);
    });

    await this.page.addInitScript({
      content: audioBridgeScript({
        // Web Speech plays through a real output device, so the page must be
        // allowed to open the real input device the cable feeds back in.
        injectMicrophone: this.tts.name !== 'webspeech',
        outputSampleRate: CAPTURE_SAMPLE_RATE,
        frameMs: CAPTURE_FRAME_MS,
      }),
    });

    this.installed = true;
  }

  /**
   * Confirms the bridge survived the page load and is wired to the meeting.
   *
   * Called after the bot is admitted, because none of it can be true earlier:
   * Meet only asks for a microphone and only opens peer connections once it is
   * actually in a call.
   */
  async verifyBridge(): Promise<void> {
    const status = await this.page
      .evaluate(() => (window as unknown as MeetBotWindow).__meetBot?.status() ?? null)
      .catch(() => null);

    if (!status) {
      throw new BotError('AUDIO_BRIDGE_FAILED', 'the injected audio bridge is not present on the page');
    }

    if (this.tts.name !== 'webspeech' && !status.micInjected) {
      throw new BotError(
        'MICROPHONE_UNAVAILABLE',
        'Google Meet never asked for a microphone, so the interviewer has no way to be heard',
      );
    }

    if (status.errors.length) {
      console.warn(`[meet-bot ${this.opts.interviewId}] bridge reported: ${status.errors.join('; ')}`);
    }

    console.log(
      `[meet-bot ${this.opts.interviewId}] audio bridge ready — context ${status.contextState}, ` +
        `mic ${status.micInjected ? 'injected' : 'passthrough'}, ${status.remoteTracks} remote track(s)`,
    );

    this.watchCapture();
  }

  /**
   * Makes sure the bot can actually hear.
   *
   * The WebRTC tap covers Meet and Teams. Zoom decodes audio in WebAssembly and
   * never creates a remote track, so nothing arrives and — as seen in a real
   * interview — the bot asks twelve questions into silence and scores the
   * candidate absent. This notices that within a few seconds and turns on the
   * Web Audio and media-element taps instead.
   */
  private watchCapture(): void {
    this.captureTimers.push(
      setTimeout(() => {
        if (this.disposed || this.audioSeen) return;

        void this.page
          .evaluate(() => (window as unknown as MeetBotWindow).__meetBot?.enableFallbackCapture())
          .then(() =>
            console.warn(
              `[meet-bot ${this.opts.interviewId}] no audio from the WebRTC tap after ${
                CAPTURE_FALLBACK_MS / 1000
              }s — enabling the Web Audio and media-element taps`,
            ),
          )
          .catch(() => {});
      }, CAPTURE_FALLBACK_MS),
    );

    this.captureTimers.push(
      setTimeout(() => {
        if (this.disposed || this.audioSeen) return;

        void this.bridgeStatus().then((status) => {
          console.error(
            `[meet-bot ${this.opts.interviewId}] STILL NO AUDIO after ${CAPTURE_DEAF_MS / 1000}s. ` +
              `Bridge: ${status ? JSON.stringify(status.sources) : 'unavailable'}, ` +
              `media elements ${status?.mediaElements ?? '?'}, peak ${status?.peak ?? '?'}. ` +
              'The interviewer cannot hear the candidate.',
          );
          this.emit('deaf', status);
        });
      }, CAPTURE_DEAF_MS),
    );
  }

  /** The bridge's own view of itself, for diagnostics and the test script. */
  async bridgeStatus(): Promise<BridgeStatus | null> {
    return this.page
      .evaluate(() => (window as unknown as MeetBotWindow).__meetBot?.status() ?? null)
      .catch(() => null);
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  private onAudioFrame(base64: string): void {
    if (this.disposed) return;

    let chunk: Buffer;
    try {
      chunk = Buffer.from(base64, 'base64');
    } catch {
      return;
    }
    if (!chunk.length) return;

    this.audioSeen = true;

    // Frames arrive continuously once anything is connected, including pure
    // silence, so their existence proves nothing about who is in the room.
    // Speech does: a meeting client does not generate it on its own.
    //
    // Measured across the whole frame rather than from a single loud sample.
    // One sample just over the noise floor is a fan, a door, or a laptop being
    // put down — none of which mean anybody is there, and all of which used to
    // be enough to start an interview in an empty meeting.
    if (!this.heardSound) {
      if (frameRms(chunk) >= SPEECH_RMS) {
        this.loudFrames++;
        // Two frames is half a second of speech-level audio. A knock or a
        // cough cannot hold that; anybody saying hello comfortably does.
        if (this.loudFrames >= 2) {
          this.heardSound = true;
          console.log(`[meet-bot ${this.opts.interviewId}] heard speech — somebody is in the meeting`);
        }
      } else {
        // Consecutive, so scattered thumps never add up to a person.
        this.loudFrames = 0;
      }
    }
    this.speech ??= this.openSpeechSession();
    this.speech.send(chunk);
  }

  private onBridgeEvent(payload: string): void {
    try {
      const event = JSON.parse(payload) as { type: string; detail: string | null };
      if (event.type === 'error') {
        console.warn(`[meet-bot ${this.opts.interviewId}] bridge error: ${event.detail}`);
        return;
      }
      console.log(`[meet-bot ${this.opts.interviewId}] bridge: ${event.type}${event.detail ? ` (${event.detail})` : ''}`);
    } catch {
      // A malformed event is a diagnostic loss, never a reason to stop.
    }
  }

  private openSpeechSession(): SpeechSession {
    const session = new SpeechSession(
      this.opts.interviewId,
      this.opts.language,
      { encoding: 'linear16', sampleRate: CAPTURE_SAMPLE_RATE, channels: 1 },
      this.opts.skills,
    );

    session.on('transcript', (result: SpeechResult) => {
      if (!result.isFinal) {
        if (!this.accepting) return;
        this.emit('interim', { text: result.text });
        this.settler.addInterim();
        return;
      }

      this.settler.addFinal(result.text, result.confidence);
      if (result.speechFinal) this.endOfTurn();
    });

    // Deepgram's utterance boundary is the backstop for when speech_final never
    // arrives — a candidate trailing off mid-sentence, most often.
    session.on('utteranceEnd', () => this.endOfTurn());

    // A dropped socket must not leave a submission scheduled behind it.
    session.on('closed', () => this.settler.cancel());

    session.on('error', (err: Error) => {
      this.emit('speechFailed', new BotError('SPEECH_TO_TEXT_UNAVAILABLE', err.message));
    });

    session.start();
    return session;
  }

  /** The recogniser believes the candidate has stopped. */
  private endOfTurn(): void {
    if (!this.accepting) {
      // Heard while the interviewer was speaking or thinking. Almost certainly
      // the AI's own voice coming back through the candidate's microphone.
      this.settler.discard();
      return;
    }

    this.settler.endOfTurn();
  }

  /** The wait elapsed in silence: whatever was said is the whole answer. */
  private submit({ text, confidence, lastHeardAt }: SettledAnswer): void {
    // The gate can shut while an answer is settling.
    if (!this.accepting) return;

    // A meeting carries every noise in every participant's room. The gate in
    // the bridge keeps most of it out of the recogniser; this catches what
    // still came back as words, because accepting it would both pollute the
    // transcript and move the interview past an unanswered question.
    if (isLikelyNoise(text, confidence)) {
      console.log(`[meet-bot ${this.opts.interviewId}] ignored background noise: "${text}" (${confidence.toFixed(2)})`);
      return;
    }

    // Measured to when they stopped talking, not to now — the three seconds
    // spent waiting on them are ours, and counting them would show up as
    // hesitation the candidate never displayed.
    const latencyMs = Math.max(0, lastHeardAt - this.turnStartedAt);
    this.turnStartedAt = Date.now();

    this.emit('transcript', { text, confidence, latencyMs });
  }

  // -------------------------------------------------------------------------
  // Gate
  // -------------------------------------------------------------------------

  /** Starts treating what is heard as the candidate's answer. */
  beginListening(): void {
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;

    // Drop anything buffered while the gate was shut, so the previous turn's
    // stray audio cannot be prepended to this answer — and with it any wait
    // still running from that turn.
    this.settler.discard();

    this.accepting = true;
    this.turnStartedAt = Date.now();
  }

  /** Stops treating what is heard as an answer. */
  stopListening(): void {
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    this.settler.cancel();
    this.accepting = false;
  }

  // -------------------------------------------------------------------------
  // Output
  // -------------------------------------------------------------------------

  /**
   * Speaks one line into the meeting and returns once it has been heard.
   *
   * `expectsAnswer` decides whether the gate reopens afterwards, so a closing
   * remark does not leave the interviewer listening to a room it is done with.
   */
  async speak(text: string, opts: { expectsAnswer: boolean; signal?: AbortSignal }): Promise<void> {
    const line = text.replace(/\s+/g, ' ').trim();
    if (!line || this.disposed) return;

    this.stopListening();
    this.speaking = true;

    try {
      await this.tts.speak(this.page, line, { language: this.opts.language, signal: opts.signal });
    } finally {
      this.speaking = false;
    }

    if (!opts.expectsAnswer || this.disposed) return;

    await new Promise<void>((resolve) => {
      this.resumeTimer = setTimeout(() => {
        this.resumeTimer = null;
        this.beginListening();
        resolve();
      }, LISTEN_RESUME_DELAY_MS);
    });
  }

  async stopSpeaking(): Promise<void> {
    this.speaking = false;
    await this.tts.stop(this.page).catch(() => {});
  }

  // -------------------------------------------------------------------------

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    this.settler.discard();
    for (const timer of this.captureTimers) clearTimeout(timer);
    this.captureTimers = [];
    this.accepting = false;

    this.speech?.stop();
    this.speech = null;
    this.removeAllListeners();
  }
}
