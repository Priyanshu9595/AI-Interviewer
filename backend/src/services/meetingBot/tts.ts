import type { Page } from 'playwright';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
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

/** Rates Aura will return linear16 at. Anything else is rejected. */
const AURA_RATES = [8_000, 16_000, 24_000, 32_000, 48_000];

/**
 * Asking for audio at the rate the page will play it at.
 *
 * Speech is streamed in pieces, each becoming its own AudioBuffer, so a
 * mismatched rate means Chromium resamples every piece separately. That was
 * measured rather than assumed, on the suspicion that the joins were what made
 * the voice sound synthetic: against a 440 Hz reference, chunked 24 kHz and a
 * single unbroken 24 kHz buffer both came out at 0.0008 RMS error. The joins
 * cost nothing — Chromium carries the resampler across them — and 0.0008 is
 * around -62 dB, which nobody can hear.
 *
 * Matching the rate is kept because it is free and removes the resampler
 * entirely (0.0000), but it is not why the voice sounds the way it does. What
 * that turned out to be is in `speakable` below.
 */
async function outputSampleRate(page: Page): Promise<number> {
  const rate = await page
    .evaluate(() => (window as unknown as MeetBotWindow).__meetBot?.status()?.sampleRate ?? 0)
    .catch(() => 0);

  return AURA_RATES.includes(rate) ? rate : AURA_SAMPLE_RATE;
}

/** Aura rejects very long inputs; interview turns are far shorter than this. */
const MAX_TTS_CHARS = 1_800;

/**
 * The interviewer's voice for languages Deepgram Aura cannot speak.
 *
 * Aura covers English (plus a handful of European languages under other model
 * names), and nothing Indic — so a Hindi or Telugu interview needs a different
 * synthesiser. Microsoft Edge's neural voices cover every language the
 * interview can be conducted in, cost nothing and need no key; the trade-off is
 * that it is Edge's own endpoint rather than a contracted API, so English stays
 * on Aura and only sessions that cannot use Aura take this path.
 */
const EDGE_VOICES: Record<string, string> = {
  'hi-IN': 'hi-IN-SwaraNeural',
  'te-IN': 'te-IN-ShrutiNeural',
  'ta-IN': 'ta-IN-PallaviNeural',
  'bn-IN': 'bn-IN-TanishaaNeural',
  'mr-IN': 'mr-IN-AarohiNeural',
  'es-ES': 'es-ES-ElviraNeural',
  'fr-FR': 'fr-FR-DeniseNeural',
  'de-DE': 'de-DE-KatjaNeural',
  'pt-BR': 'pt-BR-FranciscaNeural',
  'ja-JP': 'ja-JP-NanamiNeural',
  'zh-CN': 'zh-CN-XiaoxiaoNeural',
  'ar-SA': 'ar-SA-ZariyahNeural',
};

/** The Edge endpoint only serves containers; PCM comes from decoding its MP3. */
const EDGE_SAMPLE_RATE = 24_000;

/**
 * mpg123-decoder is ESM-only and this codebase compiles to CommonJS, where a
 * transpiled import() becomes a require() that cannot load it. The indirection
 * through Function keeps the dynamic import out of the compiler's reach.
 */
const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<{
  MPEGDecoder: new () => {
    ready: Promise<unknown>;
    decode(data: Uint8Array): { channelData: Float32Array[]; samplesDecoded: number; sampleRate: number };
    free(): void;
  };
}>;

function floatToPcm16(mono: Float32Array, samples: number): Buffer {
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const s = Math.max(-1, Math.min(1, mono[i] ?? 0));
    pcm.writeInt16LE(Math.round(s * 32_767), i * 2);
  }
  return pcm;
}

/**
 * Synthesises through an Edge neural voice, streaming into the meeting.
 *
 * Each MP3 chunk is decoded and pushed as it arrives — the decoder keeps its
 * own state across chunks, so partial frames at chunk boundaries are handled
 * for us. This used to buffer the entire utterance before playing a sample,
 * which added a second or two of dead air to every non-English turn on top of
 * the model's own thinking time; the candidate now hears the first words while
 * the rest of the line is still being synthesised, matching how the Aura path
 * has always behaved.
 */
async function streamViaEdge(page: Page, voice: string, text: string, signal?: AbortSignal): Promise<void> {
  const tts = new MsEdgeTTS();

  try {
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

    const { MPEGDecoder } = await dynamicImport('mpg123-decoder');
    const decoder = new MPEGDecoder();
    await decoder.ready;

    try {
      const { audioStream } = tts.toStream(text);

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Edge TTS timed out')), 30_000);
        // Decode-and-push strictly in arrival order; pushPcm is async and two
        // chunks racing each other would interleave their samples.
        let chain: Promise<void> = Promise.resolve();

        audioStream.on('data', (chunk: Buffer) => {
          if (signal?.aborted) {
            clearTimeout(timer);
            return reject(new Error('aborted'));
          }
          chain = chain
            .then(async () => {
              const { channelData, samplesDecoded } = decoder.decode(chunk);
              if (!samplesDecoded) return;
              await pushPcm(page, floatToPcm16(channelData[0] ?? new Float32Array(0), samplesDecoded), EDGE_SAMPLE_RATE);
            })
            .catch((err) => {
              clearTimeout(timer);
              reject(err);
            });
        });

        audioStream.on('end', () => {
          clearTimeout(timer);
          void chain.then(resolve, reject);
        });

        audioStream.on('error', (err: Error) => {
          clearTimeout(timer);
          reject(err);
        });
      });
    } finally {
      decoder.free();
    }
  } finally {
    tts.close();
  }
}

/**
 * Written English, turned into something worth listening to.
 *
 * This is the difference between the interviewer sounding synthetic and
 * sounding like a person, and none of it is about audio quality. A voice model
 * reads what it is given: "I am going to be taking your interview, and I will
 * leave time at the end" is stilted no matter how good the synthesis, because
 * nobody speaks in expanded forms. The same sentence with contractions lands
 * as ordinary speech.
 *
 * The typography matters too. An em dash is a visual device with no spoken
 * equivalent, and Aura renders one as a hard stop mid-clause; a comma gives the
 * short breath that was meant. Curly quotes and ellipses have the same problem.
 *
 * Applied at the last possible moment, so the transcript the recruiter reads
 * keeps its proper punctuation and only the audio is colloquial.
 */
export function speakable(text: string): string {
  return (
    text
      // Dashes are pauses when spoken, not punctuation.
      .replace(/\s*[—–]\s*/g, ', ')
      .replace(/\.{3,}|…/g, ', ')
      // Typographic quotes and apostrophes; the contraction rules below need
      // straight ones to match, and Aura reads the curly forms inconsistently.
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '')
      // Contractions. Ordered longest-first so "I am going to" does not get
      // half-replaced, and case-insensitive with the capital preserved.
      // "have" is deliberately absent. English contracts it only when it is an
      // auxiliary — "you've applied" — and never when it is the main verb, so a
      // blanket rule produced "we've about fifteen minutes" and "do you've any
      // questions". Telling the two apart needs the following participle, which
      // is more grammar than this is worth. Leaving "we have" alone is a shade
      // formal; the alternative was wrong English read aloud to a candidate.
      .replace(/\bI am\b/g, "I'm")
      .replace(/\bI will\b/g, "I'll")
      .replace(/\bI would\b/g, "I'd")
      .replace(/\byou are\b/gi, (m) => (m[0] === 'Y' ? "You're" : "you're"))
      .replace(/\byou will\b/gi, (m) => (m[0] === 'Y' ? "You'll" : "you'll"))
      .replace(/\bwe are\b/gi, (m) => (m[0] === 'W' ? "We're" : "we're"))
      .replace(/\bwe will\b/gi, (m) => (m[0] === 'W' ? "We'll" : "we'll"))
      .replace(/\bthat is\b/gi, (m) => (m[0] === 'T' ? "That's" : "that's"))
      .replace(/\bthere is\b/gi, (m) => (m[0] === 'T' ? "There's" : "there's"))
      .replace(/\bit is\b/gi, (m) => (m[0] === 'I' ? "It's" : "it's"))
      .replace(/\bdo not\b/gi, (m) => (m[0] === 'D' ? "Don't" : "don't"))
      .replace(/\bdoes not\b/gi, (m) => (m[0] === 'D' ? "Doesn't" : "doesn't"))
      .replace(/\bdid not\b/gi, (m) => (m[0] === 'D' ? "Didn't" : "didn't"))
      .replace(/\bcannot\b/gi, (m) => (m[0] === 'C' ? "Can't" : "can't"))
      .replace(/\bwill not\b/gi, (m) => (m[0] === 'W' ? "Won't" : "won't"))
      .replace(/\bis not\b/gi, (m) => (m[0] === 'I' ? "Isn't" : "isn't"))
      .replace(/\bare not\b/gi, (m) => (m[0] === 'A' ? "Aren't" : "aren't"))
      .replace(/\bhave not\b/gi, (m) => (m[0] === 'H' ? "Haven't" : "haven't"))
      .replace(/\blet us\b/gi, (m) => (m[0] === 'L' ? "Let's" : "let's"))
      .replace(/\s{2,}/g, ' ')
      .trim()
  );
}

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
    const spoken = speakable(text).slice(0, MAX_TTS_CHARS);
    if (!spoken) return;

    // Aura is English-only; other languages go out through an Edge neural
    // voice for that locale, decoded to the same PCM the bridge already plays.
    const edgeVoice = EDGE_VOICES[opts.language];
    if (edgeVoice) {
      try {
        await streamViaEdge(page, edgeVoice, spoken, opts.signal);
      } catch (err) {
        if (opts.signal?.aborted) return;
        throw new BotError('TTS_UNAVAILABLE', `Edge TTS (${edgeVoice}) failed: ${(err as Error).message}`);
      }

      await waitUntilSpoken(page, opts.signal);
      return;
    }

    const rate = await outputSampleRate(page);

    const params = new URLSearchParams({
      model: env.MEET_BOT_TTS_MODEL,
      encoding: 'linear16',
      sample_rate: String(rate),
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

        await pushPcm(page, carry.subarray(0, usable), rate);
        carry = carry.subarray(usable);
      }

      const tail = carry.length - (carry.length % 2);
      if (tail > 0) await pushPcm(page, carry.subarray(0, tail), rate);
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
    const spoken = speakable(text);
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

async function pushPcm(page: Page, pcm: Buffer, sampleRate: number): Promise<void> {
  await page.evaluate(
    ([base64, rate]) => (window as unknown as MeetBotWindow).__meetBot?.speak(base64 as string, rate as number),
    [pcm.toString('base64'), sampleRate] as const,
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
