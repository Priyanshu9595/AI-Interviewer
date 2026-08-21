import { z } from 'zod';
import { env } from './env';

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/**
 * Which service the model calls go to.
 *
 * Groq and Mistral both speak the OpenAI chat-completions shape, so one small
 * fetch serves both and the only differences are the URL, the key and the
 * model names. The vendor SDK was dropped for exactly that reason: it hard
 * codes `/openai/v1/chat/completions`, which is Groq's path and nobody else's,
 * so pointing it at another host quietly produces 404s.
 */
interface Provider {
  readonly name: 'groq' | 'mistral';
  readonly url: string;
  readonly apiKey: string;
  /** Used for conversational turns, where the candidate is waiting. */
  readonly fastModel: string;
  /** Used for question generation and scoring, where quality outweighs speed. */
  readonly smartModel: string;
}

const groq: Provider = {
  name: 'groq',
  url: 'https://api.groq.com/openai/v1/chat/completions',
  apiKey: env.GROQ_API_KEY ?? '',
  fastModel: env.GROQ_FAST_MODEL,
  smartModel: env.GROQ_SMART_MODEL,
};

const mistral: Provider = {
  name: 'mistral',
  url: 'https://api.mistral.ai/v1/chat/completions',
  apiKey: env.MISTRAL_API_KEY ?? '',
  fastModel: env.MISTRAL_FAST_MODEL,
  smartModel: env.MISTRAL_SMART_MODEL,
};

/**
 * The fast and smart roles are routed independently, because the two providers
 * are good at different things: Groq's hardware answers a conversational turn
 * in a fraction of the time (and the candidate is sitting there waiting for
 * it), while Mistral's quota is far roomier for the heavy, off-the-clock work
 * — question generation, evaluation, script translation.
 *
 * With both keys present that split is the default. `LLM_PROVIDER` pins
 * everything to one provider when that is what you want.
 */
function resolveRouting(): { fast: Provider; smart: Provider; label: string } {
  if (env.LLM_PROVIDER === 'groq') return { fast: groq, smart: groq, label: 'groq' };
  if (env.LLM_PROVIDER === 'mistral') return { fast: mistral, smart: mistral, label: 'mistral' };

  if (groq.apiKey && mistral.apiKey) {
    return { fast: groq, smart: mistral, label: 'groq (fast) + mistral (smart)' };
  }

  const only = mistral.apiKey ? mistral : groq;
  return { fast: only, smart: only, label: only.name };
}

const routing = resolveRouting();

/** What /health reports as the live provider. */
export const providerLabel = routing.label;

/** The two model names. Which service serves each is the routing's business. */
export const FAST_MODEL = routing.fast.fastModel;
export const SMART_MODEL = routing.smart.smartModel;

/** Every call names a model; the model decides which provider answers it. */
function providerFor(model: string): Provider {
  if (model === routing.smart.smartModel) return routing.smart;
  return routing.fast;
}

/**
 * Which service answers this model, for diagnostics and tests.
 *
 * The cooldown is keyed by provider, so anything reasoning about it needs the
 * same answer the implementation uses rather than a guess from the routing.
 */
export function providerOf(model: string): Provider['name'] {
  return providerFor(model).name;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
}

/**
 * Provider-specific adjustments to an outgoing request.
 *
 * Groq's gpt-oss models think before they answer, and the thinking is spent
 * out of max_tokens. Left at the default effort a turn as simple as
 * "acknowledge this and move on" burns 150 tokens reasoning about it — which
 * makes the candidate wait, and against the smaller budgets some callers use
 * consumes the entire allowance and returns an empty reply. Nothing asked of
 * the fast model here is a reasoning problem, so ask for the least of it: the
 * same turn then costs 26 tokens and arrives in a third of the time.
 */
function tune(provider: Provider, body: Record<string, unknown>): Record<string, unknown> {
  const model = String(body.model ?? '');
  if (provider.name === 'groq' && /gpt-oss/.test(model)) {
    return { ...body, reasoning_effort: 'low' };
  }
  return body;
}

/** One chat-completions call. Shared by both entry points below. */
async function chat(provider: Provider, body: Record<string, unknown>): Promise<string> {
  if (!provider.apiKey) {
    throw new Error(`${provider.name.toUpperCase()}_API_KEY is not set, so the interviewer has no language model.`);
  }

  const res = await fetch(provider.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(tune(provider, body)),
    signal: AbortSignal.timeout(90_000),
  });

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 400);
    const err = new Error(`${provider.name} returned ${res.status}: ${detail}`);
    // Carried so isRateLimit can see it without parsing the message, and so a
    // cooldown is attributed to whichever provider actually refused — which is
    // not always the one the model name pointed at.
    Object.assign(err, { status: res.status, provider: provider.name });
    throw err;
  }

  const payload = (await res.json()) as ChatResponse;
  const choice = payload.choices?.[0];
  const content = unquote(choice?.message?.content?.trim() ?? '');

  // A reply cut off before it produced anything is a budget failure, not an
  // answer. Returned as "" it would reach the candidate as the interviewer
  // saying nothing at all, with nothing in the log to explain it.
  if (!content && choice?.finish_reason === 'length') {
    throw new Error(
      `${provider.name} hit the token limit for "${String(body.model)}" before writing any reply — ` +
        `raise maxTokens for this call.`,
    );
  }

  return content;
}

/**
 * Drops quotation marks wrapped around a whole reply.
 *
 * Asked for a line to say, these models often answer `"Excellent answer, thank
 * you."` — quotes included. They are punctuation about the sentence rather
 * than part of it, and they end up in the transcript and in the mouth of the
 * interviewer. Only stripped when they enclose the entire string, so a reply
 * that genuinely quotes something keeps its quotes.
 */
function unquote(text: string): string {
  const wrapped = /^(["'“”])([\s\S]+)(["'“”])$/.exec(text);
  if (!wrapped) return text;

  const inner = wrapped[2]!;
  // A closing quote in the middle means the outer pair is not a wrapper.
  return /["'“”]/.test(inner) ? text : inner.trim();
}

/** Thrown when the provider refuses on quota rather than on the request itself. */
export class RateLimitError extends Error {
  readonly isRateLimit = true;
  /** Seconds the provider asked us to wait, when it said. */
  readonly retryAfterSeconds: number | undefined;

  constructor(cause: Error) {
    super(`LLM rate limit reached: ${cause.message.slice(0, 300)}`);
    this.name = 'RateLimitError';

    // Groq reports "Please try again in 11m24.288s", and for a daily quota
    // "1h5m25.152s". Each unit is optional, so all three forms are handled.
    const match = /try again in\s*(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:([\d.]+)s)?/i.exec(cause.message);

    if (match && (match[1] || match[2] || match[3])) {
      this.retryAfterSeconds =
        Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Math.ceil(Number(match[3] ?? 0));
    }
  }
}

function isRateLimit(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  const message = (err as Error)?.message ?? '';
  return status === 429 || /rate.?limit|too many requests|quota/i.test(message);
}

/**
 * When a provider blocks on a *daily* quota, every call to it will fail for
 * the next hour. Remembering that stops each caller rediscovering it — which
 * otherwise floods the log and wastes a request per retry.
 *
 * Tracked per provider, because the whole point of the split routing is that
 * Groq exhausting its conversation quota must not pause Mistral's evaluations,
 * and vice versa.
 */
const cooldownUntil = new Map<Provider['name'], number>();

export const llmCooldown = {
  /**
   * Seconds remaining before calls for this model should be attempted again,
   * or 0 to proceed. Defaults to the smart model, which is what the evaluation
   * queue — the one external caller — is actually waiting on.
   */
  remainingSeconds(model: string = SMART_MODEL): number {
    const left = Math.ceil(((cooldownUntil.get(providerFor(model).name) ?? 0) - Date.now()) / 1000);
    return left > 0 ? left : 0;
  },

  engage(seconds: number, providerName: Provider['name']) {
    const until = Date.now() + seconds * 1000;
    // Never shorten an existing cooldown.
    if (until > (cooldownUntil.get(providerName) ?? 0)) {
      cooldownUntil.set(providerName, until);
      console.warn(
        `[ai] ${providerName} quota exhausted — pausing its calls for ${Math.ceil(seconds / 60)} minute(s)`,
      );
    }
  },

  clear() {
    cooldownUntil.clear();
  },
};

/** Throws immediately if this provider is known to be rate limited right now. */
function assertNotCoolingDown(provider: Provider) {
  const left = Math.ceil(((cooldownUntil.get(provider.name) ?? 0) - Date.now()) / 1000);
  if (left > 0) {
    const err = new RateLimitError(
      new Error(`${provider.name} quota still exhausted, try again in ${Math.ceil(left / 60)}m`),
    );
    // The parsed hint from the original message is not present here, so set it.
    Object.defineProperty(err, 'retryAfterSeconds', { value: left, writable: false });
    throw err;
  }
}

/** Which provider actually refused, when the error carries it. */
function blamedProvider(err: unknown, fallback: Provider['name']): Provider['name'] {
  return (err as { provider?: Provider['name'] })?.provider ?? fallback;
}

/**
 * Whether the provider is saying the model name itself is no good.
 *
 * Distinct from every other failure because it is permanent: retrying spends
 * the candidate's time on a request that cannot start succeeding.
 */
function isModelUnavailable(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status !== 400 && status !== 404) return false;
  return /model_not_found|does not exist|decommission|deprecat|invalid[_ ]model|unknown model/i.test(
    (err as Error)?.message ?? '',
  );
}

/**
 * Model names the provider has told us it does not serve.
 *
 * Remembered so the discovery costs one wasted call rather than one per turn
 * for the rest of the process's life.
 */
const retired = new Set<string>();

/**
 * The other provider's model for the same role.
 *
 * An explicit LLM_PROVIDER pin is respected: crossing to a service the
 * operator deliberately excluded would be a worse surprise than failing, and
 * the thrown error names the setting to correct.
 */
function alternateFor(model: string): { provider: Provider; model: string } | null {
  // 'auto' is the default and means "no preference", not a pin.
  if (env.LLM_PROVIDER !== 'auto') return null;

  const other = providerFor(model).name === 'groq' ? mistral : groq;
  if (!other.apiKey) return null;

  const isSmart = model === routing.smart.smartModel;
  return { provider: other, model: isSmart ? other.smartModel : other.fastModel };
}

/**
 * One chat call, with a retired model name moved to the other provider.
 *
 * Providers drop model names on their own schedule and the configured one
 * simply stops existing. Without this the interviewer answers every single
 * turn with a neutral acknowledgement — three wasted round trips each — and
 * the interview quietly becomes worthless while looking like it is running.
 */
async function send(model: string, body: (m: string) => Record<string, unknown>): Promise<string> {
  const known = retired.has(model) ? alternateFor(model) : null;
  const provider = known?.provider ?? providerFor(model);
  const name = known?.model ?? model;

  assertNotCoolingDown(provider);

  try {
    return await chat(provider, body(name));
  } catch (err) {
    // Already substituted once; a second failure is the substitute's own.
    if (!isModelUnavailable(err) || known) throw err;

    retired.add(model);
    const alt = alternateFor(model);

    if (!alt) {
      throw new Error(
        `${provider.name} no longer serves the model "${name}". ` +
          `Set ${provider.name.toUpperCase()}_FAST_MODEL and ${provider.name.toUpperCase()}_SMART_MODEL ` +
          `to names the account can use.`,
      );
    }

    console.warn(
      `[ai] ${provider.name} no longer serves "${name}" — falling back to ${alt.provider.name} "${alt.model}". ` +
        `Update ${provider.name.toUpperCase()}_FAST_MODEL / _SMART_MODEL.`,
    );

    assertNotCoolingDown(alt.provider);
    return await chat(alt.provider, body(alt.model));
  }
}

/**
 * Strips markdown fences and any prose that models sometimes wrap around JSON,
 * then returns the outermost JSON object.
 */
export function extractJson(raw: string): string {
  let text = raw.trim();

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) text = fence[1].trim();

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) text = text.slice(start, end + 1);

  return text.trim();
}

interface CompleteOptions {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export async function complete({
  messages,
  model = FAST_MODEL,
  temperature = 0.6,
  maxTokens = 1024,
}: CompleteOptions): Promise<string> {
  try {
    return await send(model, (m) => ({ model: m, messages, temperature, max_tokens: maxTokens }));
  } catch (err) {
    if (isRateLimit(err)) {
      const rateLimit = new RateLimitError(err as Error);
      if (rateLimit.retryAfterSeconds) {
        llmCooldown.engage(rateLimit.retryAfterSeconds, blamedProvider(err, providerFor(model).name));
      }
      throw rateLimit;
    }
    throw err;
  }
}

interface JsonOptions<T extends z.ZodTypeAny> extends CompleteOptions {
  schema: T;
  /** Attempts before giving up and surfacing the error. */
  retries?: number;
}

/**
 * Requests JSON from the model and validates it against a Zod schema. On a
 * parse or validation failure the error is fed back to the model so it can
 * repair its own output rather than the caller receiving garbage.
 */
export async function completeJson<T extends z.ZodTypeAny>({
  schema,
  messages,
  model = FAST_MODEL,
  temperature = 0.4,
  maxTokens = 4096,
  retries = 2,
}: JsonOptions<T>): Promise<z.infer<T>> {
  const convo = [...messages];
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    let raw = '';
    try {
      raw = await send(model, (m) => ({
        model: m,
        messages: convo,
        temperature,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
      }));
      return schema.parse(JSON.parse(extractJson(raw)));
    } catch (err) {
      lastError = err;

      // A model name the provider will not serve is permanent, and send() has
      // already tried the alternative. Three more attempts would only make the
      // candidate wait longer for the same failure.
      if (isModelUnavailable(err)) throw err;

      // Retrying a rate limit immediately just burns the remaining attempts and
      // buries the real cause behind "failed after 3 attempts". Surface it now
      // so the caller can decide to back off and try later.
      if (isRateLimit(err)) {
        const rateLimit = new RateLimitError(err as Error);
        // Back off even when the provider gave no hint — a quota block that we
        // cannot time is exactly the case where hammering does most damage.
        llmCooldown.engage(
          rateLimit.retryAfterSeconds ?? 5 * 60,
          blamedProvider(err, providerFor(model).name),
        );
        throw rateLimit;
      }

      const reason =
        err instanceof z.ZodError
          ? err.issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ')
          : (err as Error).message;

      if (attempt === retries) break;

      convo.push({ role: 'assistant', content: raw.slice(0, 2000) });
      convo.push({
        role: 'user',
        content: `That response was rejected: ${reason}. Reply with corrected JSON only. No prose, no code fences.`,
      });
    }
  }

  throw new Error(`Model failed to produce valid JSON after ${retries + 1} attempts: ${String(lastError)}`);
}
