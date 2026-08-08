import type { Page } from 'playwright';
import { env } from '../../lib/env';
import { BotError } from './errors';

/**
 * Turning the interviewer's words into audio the meeting can hear.
 *
 * Two drivers, because the two halves of the problem pull in opposite
 * directions:
 *
 *  - `webspeech` is the browser's own SpeechSynthesis API. Free, no key, and
 *    what the MVP asked for — but it plays to a sound device and hands back no
 *    samples, so on its own it reaches nobody. It only works when the host
 *    routes the output device into the browser's microphone with a virtual
 *    audio cable (VB-CABLE on Windows).
 *
 *  - `deepgram` synthesises server-side and returns PCM, which goes straight
 *    into the synthetic microphone the audio bridge installs. Nothing to set up
 *    on the host, works headless, and reuses the Deepgram key the bot already
 *    needs for transcription.
 *
 * `deepgram` is the default for that reason. `webspeech` stays fully supported
 * for anyone who would rather configure a cable than spend on synthesis.
 */

export interface SpeakOptions {
  /** BCP-47 tag from the interview session, e.g. "en-US". */
  language: string;
  /** Aborts mid-sentence when the interview is stopped or the meeting dies. */
  signal?: AbortSignal;
}

export interface TtsDriver {
  readonly name: 'deepgram' | 'webspeech';
  /** Whether the AI's voice needs an operating-system audio route to be heard. */
  readonly needsVirtualAudioDevice: boolean;
  /** Confirms the driver can actually produce speech, before a meeting starts. */
  verify(): Promise<void>;
  /** Resolves once the meeting has finished hearing the whole utterance. */
  speak(page: Page, text: string, opts: SpeakOptions): Promise<void>;
  /** Cuts the current utterance short. */
  stop(page: Page): Promise<void>;
}

/** Deepgram Aura returns raw little-endian 16-bit PCM at whatever rate we ask. */
const AURA_SAMPLE_RATE = 24_000;

/** Aura rejects very long inputs; interview turns are far shorter than this. */
const MAX_TTS_CHARS = 1_800;

class DeepgramTts implements TtsDriver {
  readonly name = 'deepgram' as const;
  readonly needsVirtualAudioDevice = false;

  async verify(): Promise<void> {
    if (!env.DEEPGRAM_API_KEY) {
      throw new BotError(
        'TTS_UNAVAILABLE',
        'MEET_BOT_TTS=deepgram needs DEEPGRAM_API_KEY. Set the key, or switch to MEET_BOT_TTS=webspeech and configure a virtual audio cable.',
      );
    }
  }

  async speak(page: Page, text: string, opts: SpeakOptions): Promise<void> {
    const spoken = text.trim().slice(0, MAX_TTS_CHARS);
    if (!spoken) return;

    const params = new URLSearchParams({
      model: env.MEET_BOT_TTS_MODEL,
      encoding: 'linear16',
      sample_rate: String(AURA_SAMPLE_RATE),
      container: 'none',
    });

    const response = await fetch(`https://api.deepgram.com/v1/speak?${params}`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${env.DEEPGRAM_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: spoken }),
      signal: opts.signal,
    });

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new BotError('TTS_UNAVAILABLE', `Deepgram speak returned ${response.status}: ${detail.slice(0, 200)}`);
    }

    const reader = response.body.getReader();
    // Audio is forwarded as it arrives so the candidate hears the first words
    // while the rest is still being generated. A whole-response wait would add
    // a second of dead air to every question.
    let carry = Buffer.alloc(0);

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (opts.signal?.aborted) throw new Error('aborted');

        carry = Buffer.concat([carry, Buffer.from(value)]);

        // Only whole 16-bit samples may cross into the page; a split sample
        // would be reassembled as noise.
        const usable = carry.length - (carry.length % 2);
        if (usable < 4_096) continue;

        await pushPcm(page, carry.subarray(0, usable));
        carry = carry.subarray(usable);
      }

      const tail = carry.length - (carry.length % 2);
      if (tail > 0) await pushPcm(page, carry.subarray(0, tail));
    } finally {
      reader.cancel().catch(() => {});
    }

    await waitUntilSpoken(page, opts.signal);
  }

  async stop(page: Page): Promise<void> {
    await page
      .evaluate(() => (window as unknown as MeetBotWindow).__meetBot?.stopSpeaking())
      .catch(() => {});
  }
}

class WebSpeechTts implements TtsDriver {
  readonly name = 'webspeech' as const;
  readonly needsVirtualAudioDevice = true;

  async verify(): Promise<void> {
    // There is nothing to check from here: whether the utterance reaches the
    // meeting depends on the host's audio routing, which only shows up live.
    console.log(
      '[meet-bot] using the Web Speech API for the interviewer voice — it reaches the meeting only if this machine routes its audio output into the browser microphone (see docs/GOOGLE_MEET_BOT.md)',
    );
  }

  async speak(page: Page, text: string, opts: SpeakOptions): Promise<void> {
    const spoken = text.trim();
    if (!spoken) return;

    const result = await page.evaluate(
      ([value, lang, rate]) =>
        (window as unknown as MeetBotWindow).__meetBot!.speakWebSpeech(
          value as string,
          lang as string,
          rate as number,
        ),
      [spoken, opts.language, env.MEET_BOT_TTS_RATE] as const,
    );

    if (!result?.ok) {
      throw new BotError('TTS_UNAVAILABLE', `SpeechSynthesis failed: ${result?.reason ?? 'unknown'}`);
    }
  }

  async stop(page: Page): Promise<void> {
    await page
      .evaluate(() => (window as unknown as MeetBotWindow).__meetBot?.stopSpeaking())
      .catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Page plumbing
// ---------------------------------------------------------------------------

/** Shape of the bridge the injected script installs, for type-safe evaluate(). */
export interface BridgeStatus {
  contextState: string;
  sampleRate: number;
  micInjected: boolean;
  micTracks: number;
  remoteTracks: number;
  capturing: boolean;
  queuedSeconds: number;
  fallbackEnabled: boolean;
  /** How many streams each tap found. */
  sources: { rtc: number; webaudio: number; element: number };
  /** Frames handed to Node so far. */
  frames: number;
  /** Loudest sample seen, 0..1. Zero with sources attached means silence. */
  peak: number;
  mediaElements: number;
  errors: string[];
}

export interface MeetBotWindow {
  __meetBot?: {
    speak(base64: string, sampleRate: number): number;
    remaining(): number;
    stopSpeaking(): void;
    speakWebSpeech(text: string, lang: string, rate: number): Promise<{ ok: boolean; reason: string | null }>;
    enableFallbackCapture(): unknown;
    status(): BridgeStatus;
  };
}

async function pushPcm(page: Page, pcm: Buffer): Promise<void> {
  await page.evaluate(
    ([base64, rate]) => (window as unknown as MeetBotWindow).__meetBot?.speak(base64 as string, rate as number),
    [pcm.toString('base64'), AURA_SAMPLE_RATE] as const,
  );
}

/**
 * Blocks until the meeting has actually heard everything queued.
 *
 * The interview must not ask its next question over the top of the previous
 * one, and must not start listening for an answer while it is still talking —
 * so "spoken" means the audio has left the graph, not that it was submitted.
 */
async function waitUntilSpoken(page: Page, signal?: AbortSignal): Promise<void> {
  // Generous: a closing statement can run past twenty seconds, and stopping
  // early would truncate it. The interview's own hard stop is the real bound.
  const deadline = Date.now() + 180_000;

  for (;;) {
    if (signal?.aborted) return;
    if (Date.now() > deadline) return;

    const remaining = await page
      .evaluate(() => (window as unknown as MeetBotWindow).__meetBot?.remaining() ?? 0)
      .catch(() => 0);

    if (remaining <= 0.05) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(400, Math.max(80, remaining * 1000))));
  }
}

// ---------------------------------------------------------------------------

export function createTtsDriver(): TtsDriver {
  return env.MEET_BOT_TTS === 'webspeech' ? new WebSpeechTts() : new DeepgramTts();
}
