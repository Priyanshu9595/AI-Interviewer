import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(5000),

  DATABASE_URL: z.string().min(1),

  JWT_SECRET: z.string().min(10),
  JWT_REFRESH_SECRET: z.string().min(10),

  // Public URLs used when building candidate links inside emails.
  APP_URL: z.string().default('https://ai-interviewer-xi-nine.vercel.app'),
  API_URL: z.string().default('http://localhost:5000'),

  /**
   * Which service answers the model calls.
   *
   * `auto` with both keys set splits the work by what each is good at: Groq
   * answers the conversational turns (its hardware is several times faster,
   * and the candidate is waiting on every one), Mistral does the heavy
   * off-the-clock work — question generation, evaluation, script translation —
   * where its roomier quota matters more than speed. With one key, everything
   * runs there. Name a provider explicitly to pin all calls to it.
   */
  LLM_PROVIDER: z.enum(['auto', 'groq', 'mistral']).default('auto'),

  // Neither key is required on its own; the check below requires one of them.
  GROQ_API_KEY: z.string().optional(),
  // Groq retires model names on its own schedule and the old one simply stops
  // existing — the Llama 3.x names these defaulted to are gone. Check
  // https://console.groq.com/docs/models against the account before changing.
  GROQ_FAST_MODEL: z.string().default('openai/gpt-oss-20b'),
  GROQ_SMART_MODEL: z.string().default('openai/gpt-oss-120b'),

  MISTRAL_API_KEY: z.string().optional(),
  MISTRAL_FAST_MODEL: z.string().default('mistral-small-latest'),
  MISTRAL_SMART_MODEL: z.string().default('mistral-large-latest'),

  // Email (Brevo transactional API). Without a key the service logs instead.
  API_KEY_FOR_EMAIL: z.string().optional(),
  EMAIL_FROM: z.string().default('no-reply@aiinterview.app'),
  EMAIL_FROM_NAME: z.string().default('AI Interview Platform'),

  /**
   * Redis, for signup one-time codes.
   *
   * Optional so the rest of the app runs without it, but signup refuses to
   * start rather than fall back to memory: a code held in one process is
   * invisible to the next request when more than one instance is running,
   * which fails as "wrong code" on a code that was right.
   */
  REDIS_URL: z.string().optional(),

  // Meeting providers. Any that are unconfigured fall back to the built-in room.
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REFRESH_TOKEN: z.string().optional(),
  ZOOM_ACCOUNT_ID: z.string().optional(),
  ZOOM_CLIENT_ID: z.string().optional(),
  ZOOM_CLIENT_SECRET: z.string().optional(),
  MS_TENANT_ID: z.string().optional(),
  MS_CLIENT_ID: z.string().optional(),
  MS_CLIENT_SECRET: z.string().optional(),
  MS_ORGANIZER_ID: z.string().optional(),

  // Scheduler tick. Lower values make reminders more punctual at the cost of
  // more database round-trips.
  SCHEDULER_INTERVAL_MS: z.coerce.number().default(60_000),
  SCHEDULER_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),

  // How long the AI waits for a candidate before marking them absent.
  NO_SHOW_GRACE_MINUTES: z.coerce.number().default(5),

  // Deepgram speech-to-text. Audio is proxied through this server, so the key
  // is never exposed to the browser. Without it, the browser's own speech
  // recognition is used instead.
  DEEPGRAM_API_KEY: z.string().optional(),

  // Code execution sandbox limits.
  CODE_EXEC_TIMEOUT_MS: z.coerce.number().default(5000),
  CODE_EXEC_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),

  // -------------------------------------------------------------------------
  // Google Meet bot
  // -------------------------------------------------------------------------

  MEET_BOT_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),

  /// Chromium user-data directory holding the bot account's Google session.
  /// Sign in once with `npm run bot:login`; nothing else ever authenticates.
  GOOGLE_BOT_PROFILE_PATH: z.string().default('./.meet-bot-profile'),

  /// Base64 encoded JSON string of Google login cookies.
  /// Used to bypass the need for a persistent disk on serverless/free tiers.
  GOOGLE_BOT_COOKIES: z.string().optional(),

  /// Real Chrome handles Meet better than bundled Chromium. `chromium` uses
  /// Playwright's own build, which needs no separate Chrome install.
  MEET_BOT_BROWSER_CHANNEL: z.enum(['chrome', 'msedge', 'chromium']).default('chrome'),

  MEET_BOT_HEADLESS: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),

  /// Shown to the candidate in the participant list.
  MEET_BOT_DISPLAY_NAME: z.string().default('AI Interviewer'),

  /**
   * How many minutes before the scheduled time the bot opens the meeting.
   *
   * Zero means it joins at the scheduled time itself: a 3:00 interview is
   * joined at 3:00. Raise it to have the bot admitted and settled before the
   * candidate arrives, at the cost of it sitting in an empty meeting.
   */
  MEET_BOT_JOIN_LEAD_MINUTES: z.coerce.number().default(0),

  /**
   * How long before a run's joinAt the browser is started.
   *
   * Measured, not guessed: from the launcher firing to the bot actually being
   * in the meeting took between 9 and 62 seconds across real runs, nearly all
   * of it Chromium starting and the meeting page loading. With a lead of zero
   * that delay lands *after* the scheduled time, so a 3:00 interview had the
   * interviewer appear at 3:01.
   *
   * None of that work is visible from inside the meeting — it all happens on
   * the pre-join screen — so it is done early and the join press itself is held
   * until the scheduled second. The bot still appears at 3:00 exactly.
   */
  MEET_BOT_WARMUP_SECONDS: z.coerce.number().default(75),

  /// How long to sit in the lobby waiting for the organiser to admit the bot.
  MEET_BOT_ADMISSION_TIMEOUT_MS: z.coerce.number().default(10 * 60_000),

  /**
   * How long the bot waits for a candidate who has not arrived, counted from
   * the scheduled start rather than from when the bot joined.
   *
   * Two phases, because "five minutes late" and "not coming" are different
   * things. A 3:00 interview waits until 3:05; if nobody is there, it waits a
   * final 3:05–3:07 and then cancels. A candidate who arrives at any point in
   * either window is admitted and the interview starts immediately.
   */
  MEET_BOT_CANDIDATE_WAIT_MINUTES: z.coerce.number().default(5),
  MEET_BOT_CANDIDATE_GRACE_MINUTES: z.coerce.number().default(2),

  /// How many meetings one process will drive at once. Each is a real browser.
  MEET_BOT_MAX_CONCURRENT: z.coerce.number().default(2),

  /**
   * How the AI's voice reaches the meeting.
   *
   * `deepgram` synthesises server-side and feeds the PCM straight into the
   * synthetic microphone the bot hands Google Meet. Nothing to install.
   *
   * `webspeech` uses the browser's SpeechSynthesis API, which plays to the
   * operating system's audio device and returns no samples we can inject. It
   * therefore needs a virtual audio cable — see docs/GOOGLE_MEET_BOT.md.
   */
  MEET_BOT_TTS: z.enum(['deepgram', 'webspeech']).default('deepgram'),
  MEET_BOT_TTS_MODEL: z.string().default('aura-2-thalia-en'),

  /// Words per minute multiplier for SpeechSynthesis, when that driver is used.
  MEET_BOT_TTS_RATE: z.coerce.number().default(1),

  /**
   * Also send the coding-exercise link with the invitation email.
   *
   * Off by default: the interviewer posts it into the meeting chat when the
   * round begins, and emailing it in advance hands the candidate the exercise
   * before they have been asked for it. Turn on as a safety net for meetings
   * whose chat the candidate cannot reach.
   */
  MEET_BOT_CODING_LINK_IN_EMAIL: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),

  /**
   * Share a live view of the candidate's editor onto the meeting screen.
   *
   * Off by default. Meet shares a tab's audio along with its picture, and the
   * picker is steered by a command-line title match rather than clicked — so
   * when the match misses, the bot ends up sharing the meeting back into
   * itself and the call fills with feedback. The coding round does not need
   * it: the candidate has the editor, the link goes into the chat, and the
   * submission still reaches the interviewer.
   */
  MEET_BOT_SHARE_CODE_SCREEN: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
}).superRefine((cfg, ctx) => {
  // The key was required by the field itself until there were two providers.
  // Checked here instead so either one satisfies it, and so naming a provider
  // without its key fails at boot rather than on the first question of an
  // interview.
  const wanted = cfg.LLM_PROVIDER;
  const has = { groq: Boolean(cfg.GROQ_API_KEY), mistral: Boolean(cfg.MISTRAL_API_KEY) };

  if (wanted !== 'auto' && !has[wanted]) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [`${wanted.toUpperCase()}_API_KEY`],
      message: `LLM_PROVIDER is ${wanted}, so ${wanted.toUpperCase()}_API_KEY must be set.`,
    });
    return;
  }

  if (wanted === 'auto' && !has.groq && !has.mistral) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['MISTRAL_API_KEY'],
      message: 'Set MISTRAL_API_KEY or GROQ_API_KEY — the interviewer needs a language model.',
    });
  }
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:');
  console.error(JSON.stringify(parsed.error.flatten().fieldErrors, null, 2));
  process.exit(1);
}

export const env = parsed.data;

export const isMeetingProviderConfigured = {
  google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN),
  zoom: Boolean(env.ZOOM_ACCOUNT_ID && env.ZOOM_CLIENT_ID && env.ZOOM_CLIENT_SECRET),
  teams: Boolean(env.MS_TENANT_ID && env.MS_CLIENT_ID && env.MS_CLIENT_SECRET && env.MS_ORGANIZER_ID),
};