import crypto from 'crypto';
import { redis, redisConfigured } from '../lib/redis';

/**
 * One-time codes for e-mail verification at sign-up.
 *
 * Nothing here is written to Postgres. The account does not exist until the
 * code is right, so an abandoned sign-up leaves nothing behind and nobody can
 * take somebody else's address out of circulation by starting a sign-up with
 * it and walking away.
 *
 * Two keys per address, with different lifetimes on purpose:
 *
 *   otp:<email>      the code itself, sixty seconds
 *   signup:<email>   the form behind it, fifteen minutes
 *
 * The code is the thing that has to be short-lived. The form is not a secret —
 * the person filling it in supplied every field — so it outlives several codes
 * and a resend costs the user six digits rather than the whole form again.
 */

/** Sixty seconds, as asked for. */
const CODE_TTL_SECONDS = 60;

/** Long enough to survive a few resends without retyping the form. */
const PENDING_TTL_SECONDS = 15 * 60;

/** Wait between sends, so the endpoint cannot be used to bomb an inbox. */
const RESEND_COOLDOWN_SECONDS = 30;

/**
 * Wrong guesses before the code is burned.
 *
 * A six-digit code is a million combinations, which sounds like a lot until you
 * notice a script can try thousands inside the sixty seconds. The cap, not the
 * length, is what makes the code safe.
 */
const MAX_ATTEMPTS = 5;

export interface PendingSignup {
  email: string;
  /** Already bcrypt-hashed. The plain password is never stored, even briefly. */
  passwordHash: string;
  name: string | null;
  company: string | null;
}

interface CodeRecord {
  hash: string;
  attempts: number;
}

export type VerifyResult =
  | { ok: true; pending: PendingSignup }
  | { ok: false; reason: 'expired' | 'wrong' | 'exhausted'; attemptsLeft: number };

export type SendDecision = { ok: true; expiresInSeconds: number; code: string } | { ok: false; retryInSeconds: number };

const codeKey = (email: string) => `otp:${normalise(email)}`;
const pendingKey = (email: string) => `signup:${normalise(email)}`;
const cooldownKey = (email: string) => `otp:cooldown:${normalise(email)}`;

/** Addresses are matched case-insensitively, so the keys must be too. */
function normalise(email: string): string {
  return email.trim().toLowerCase();
}

/** SHA-256 is right here: the input has a million possibilities and sixty seconds of life. */
function hash(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

/** Six digits, uniformly distributed, from the OS. Math.random is not a secret. */
function generateCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/** Compared byte by byte so the time taken says nothing about how close a guess was. */
function sameCode(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export const otpConfigured = redisConfigured;

export class OtpService {
  /**
   * Issues a code for an address and remembers the sign-up behind it.
   *
   * Returns the code rather than sending it: what to do with it belongs to the
   * caller, and a test should be able to read it without a mailbox.
   */
  static async issue(pending: PendingSignup): Promise<SendDecision> {
    const client = redis();
    const email = normalise(pending.email);

    const cooling = await client.ttl(cooldownKey(email));
    if (cooling > 0) return { ok: false, retryInSeconds: cooling };

    const code = generateCode();
    const record: CodeRecord = { hash: hash(code), attempts: 0 };

    await client
      .multi()
      .set(codeKey(email), JSON.stringify(record), 'EX', CODE_TTL_SECONDS)
      .set(pendingKey(email), JSON.stringify({ ...pending, email }), 'EX', PENDING_TTL_SECONDS)
      .set(cooldownKey(email), '1', 'EX', RESEND_COOLDOWN_SECONDS)
      .exec();

    return { ok: true, expiresInSeconds: CODE_TTL_SECONDS, code };
  }

  /**
   * Issues a fresh code for a sign-up already in flight.
   *
   * Only works while the form is still held, so this cannot be used to send a
   * code to an address that never started a sign-up.
   */
  static async resend(email: string): Promise<SendDecision & { pending?: PendingSignup }> {
    const pending = await this.pending(email);
    if (!pending) return { ok: false, retryInSeconds: 0 };

    const decision = await this.issue(pending);
    return decision.ok ? { ...decision, pending } : decision;
  }

  /** The form behind an in-flight sign-up, if it is still held. */
  static async pending(email: string): Promise<PendingSignup | null> {
    const raw = await redis().get(pendingKey(email));
    if (!raw) return null;

    try {
      return JSON.parse(raw) as PendingSignup;
    } catch {
      return null;
    }
  }

  /**
   * Checks a code and, if it is right, hands back the sign-up and forgets both.
   *
   * A correct code is consumed, so the same code cannot create two accounts if
   * the request is repeated.
   */
  static async verify(email: string, code: string): Promise<VerifyResult> {
    const client = redis();
    const key = codeKey(email);

    const raw = await client.get(key);
    if (!raw) return { ok: false, reason: 'expired', attemptsLeft: 0 };

    let record: CodeRecord;
    try {
      record = JSON.parse(raw) as CodeRecord;
    } catch {
      await client.del(key);
      return { ok: false, reason: 'expired', attemptsLeft: 0 };
    }

    if (!sameCode(record.hash, hash(code))) {
      const attempts = record.attempts + 1;

      if (attempts >= MAX_ATTEMPTS) {
        // Burn the code rather than the sign-up: the form survives, so they can
        // ask for a new code without filling it in again.
        await client.del(key);
        return { ok: false, reason: 'exhausted', attemptsLeft: 0 };
      }

      // Keep whatever life the code had left. Re-setting the TTL here would let
      // a wrong guess extend the window it is trying to guess inside.
      const ttl = await client.ttl(key);
      const next: CodeRecord = { ...record, attempts };
      if (ttl > 0) await client.set(key, JSON.stringify(next), 'EX', ttl);
      else await client.del(key);

      return { ok: false, reason: 'wrong', attemptsLeft: MAX_ATTEMPTS - attempts };
    }

    const pending = await this.pending(email);
    if (!pending) return { ok: false, reason: 'expired', attemptsLeft: 0 };

    await client.del(key, pendingKey(email), cooldownKey(email));
    return { ok: true, pending };
  }

  /** Drops everything held for an address. Used when an account is created another way. */
  static async forget(email: string): Promise<void> {
    await redis().del(codeKey(email), pendingKey(email), cooldownKey(email));
  }

  static readonly codeTtlSeconds = CODE_TTL_SECONDS;
  static readonly resendCooldownSeconds = RESEND_COOLDOWN_SECONDS;
  static readonly maxAttempts = MAX_ATTEMPTS;
}
