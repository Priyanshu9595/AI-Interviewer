/**
 * Exercises the sign-up code store against the real Redis in .env.
 *
 * No email is sent: OtpService.issue hands the code back to its caller, which
 * is what lets this run without a mailbox.
 *
 * What matters here is the failure modes, not the happy path. A six-digit code
 * is a million combinations, which a script gets through inside a minute — so
 * the attempt cap, not the length, is what makes it safe, and a wrong guess
 * must not be able to extend the window it is guessing inside.
 *
 *   npm run verify:otp
 */
import { OtpService, otpConfigured } from '../src/services/OtpService';
import { closeRedis, redis } from '../src/lib/redis';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// A throwaway address per run, so a failed run cannot poison the next one.
const email = `otptest+${Date.now()}@example.com`;
const signup = { email, passwordHash: 'bcrypt-hash-stand-in', name: 'Otp Tester', company: 'Acme' };

async function main() {
  if (!otpConfigured) {
    console.log('REDIS_URL is not set — nothing to test against.');
    process.exit(1);
  }

  console.log(`Using ${email}`);
  console.log('');
  console.log('1. Issuing a code');

  const issued = await OtpService.issue(signup);
  if (!issued.ok) {
    console.log('  FAIL  could not issue a code');
    process.exit(1);
  }

  check('the code is six digits', /^\d{6}$/.test(issued.code), issued.code);
  check('it is advertised as lasting 60 seconds', issued.expiresInSeconds === 60);

  const stored = await redis().get(`otp:${email}`);
  check('the code is not stored in the clear', Boolean(stored) && !stored!.includes(issued.code));

  const pending = await OtpService.pending(email);
  check('the form is held alongside it', pending?.name === 'Otp Tester' && pending?.company === 'Acme');
  check('the password is held only as a hash', pending?.passwordHash === 'bcrypt-hash-stand-in');

  console.log('');
  console.log('2. Wrong codes');

  const wrong1 = await OtpService.verify(email, '000000' === issued.code ? '111111' : '000000');
  check(
    'a wrong code is refused and counted',
    !wrong1.ok && wrong1.reason === 'wrong' && wrong1.attemptsLeft === 4,
    `${wrong1.ok ? 'accepted' : `${wrong1.attemptsLeft} left`}`,
  );

  const ttlAfterWrong = await redis().ttl(`otp:${email}`);
  check(
    'a wrong guess does not extend the code',
    ttlAfterWrong > 0 && ttlAfterWrong <= 60,
    `${ttlAfterWrong}s left of 60`,
  );

  console.log('');
  console.log('3. The attempt cap is what makes six digits safe');

  for (let i = 0; i < 3; i++) await OtpService.verify(email, '000001');
  const fifth = await OtpService.verify(email, '000001');
  check(
    'the code is burned after five wrong attempts',
    !fifth.ok && fifth.reason === 'exhausted',
    !fifth.ok ? fifth.reason : 'accepted',
  );

  const afterBurn = await OtpService.verify(email, issued.code);
  check('and the right code no longer works either', !afterBurn.ok);

  const survived = await OtpService.pending(email);
  check('but the form survives, so a resend costs six digits not the whole form', survived !== null);

  console.log('');
  console.log('4. Resend');

  const tooSoon = await OtpService.resend(email);
  check(
    'a resend inside the cooldown is refused',
    !tooSoon.ok && tooSoon.retryInSeconds > 0,
    tooSoon.ok ? 'allowed' : `${tooSoon.retryInSeconds}s`,
  );

  await redis().del(`otp:cooldown:${email}`); // stand in for waiting 30s
  const resent = await OtpService.resend(email);
  check('after the cooldown a fresh code is issued', resent.ok);
  check('and it differs from the first', resent.ok && resent.code !== issued.code);

  console.log('');
  console.log('5. The right code');

  if (!resent.ok) {
    console.log('  (skipped — no code to verify)');
  } else {
    const good = await OtpService.verify(email, resent.code);
    check('the right code is accepted', good.ok);
    check('and returns the form that was held', good.ok && good.pending.email === email);

    const replay = await OtpService.verify(email, resent.code);
    check('a used code cannot be used twice', !replay.ok, 'no second account from one code');

    const gone = await OtpService.pending(email);
    check('and nothing is left behind', gone === null);
  }

  console.log('');
  console.log('6. Expiry');

  // The real code lives 60s. Waiting that out would make this suite unusable,
  // so the key is aged directly — the expiry being tested is Redis's, and it
  // does not care how the TTL got short.
  const fresh = `otptest+exp${Date.now()}@example.com`;
  const short = await OtpService.issue({ ...signup, email: fresh });
  if (short.ok) {
    await redis().expire(`otp:${fresh}`, 1);
    await wait(1600);
    const expired = await OtpService.verify(fresh, short.code);
    check('an expired code is refused', !expired.ok && expired.reason === 'expired');
    await OtpService.forget(fresh);
  }

  await OtpService.forget(email);
  await closeRedis();

  console.log('');
  console.log(failures.length ? `${failures.length} CHECK(S) FAILED` : 'OTP OK');
  process.exit(failures.length ? 1 : 0);
}

void main();
