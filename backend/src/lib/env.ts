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

  // LLM provider. Groq is the default because it is fast enough for a live
  // conversational loop.
  GROQ_API_KEY: z.string().min(1),
  GROQ_FAST_MODEL: z.string().default('llama-3.1-8b-instant'),
  GROQ_SMART_MODEL: z.string().default('llama-3.3-70b-versatile'),

  // Email (Brevo transactional API). Without a key the service logs instead.
  API_KEY_FOR_EMAIL: z.string().optional(),
  EMAIL_FROM: z.string().default('no-reply@aiinterview.app'),
  EMAIL_FROM_NAME: z.string().default('AI Interview Platform'),

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

  // Cloudinary. Without these, recordings and resumes are stored on local disk.
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),

  // Code execution sandbox limits.
  CODE_EXEC_TIMEOUT_MS: z.coerce.number().default(5000),
  CODE_EXEC_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),
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