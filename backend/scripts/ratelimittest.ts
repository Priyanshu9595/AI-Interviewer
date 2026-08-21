/**
 * Checks how the system behaves when the LLM provider blocks on quota — the
 * situation that produced a retry flood and an opaque 500 for the recruiter.
 */
import { RateLimitError, llmCooldown, providerOf, FAST_MODEL, SMART_MODEL } from '../src/lib/ai';

const failures: string[] = [];
const check = (name: string, ok: boolean) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failures.push(name);
};

// The exact shape Groq returns.
const groqMessage =
  '429 {"error":{"message":"Rate limit reached for model `llama-3.3-70b-versatile` in organization `org_x` service tier `on_demand` on tokens per day (TPD): Limit 100000, Used 97829, Requested 6714. Please try again in 1h5m25.152s.","type":"tokens","code":"rate_limit_exceeded"}}';

console.log('1. Parsing an hours+minutes+seconds hint (daily quota)');
const err = new RateLimitError(new Error(groqMessage));
console.log(`   retryAfterSeconds = ${err.retryAfterSeconds}`);
check('hours are included', err.retryAfterSeconds === 3600 + 5 * 60 + 26);
check('it is flagged for the HTTP layer', (err as unknown as { isRateLimit: boolean }).isRateLimit === true);

console.log('\n2. A plain minutes+seconds hint');
const simple = new RateLimitError(new Error('429 rate limit. Please try again in 42m32.256s.'));
console.log(`   retryAfterSeconds = ${simple.retryAfterSeconds}`);
check('minutes and seconds are combined', simple.retryAfterSeconds === 42 * 60 + 33);

console.log('\n3. A message with no hint at all');
const noHint = new RateLimitError(new Error('429 Too Many Requests'));
console.log(`   retryAfterSeconds = ${noHint.retryAfterSeconds}`);
check('an unparseable message yields no false number', noHint.retryAfterSeconds === undefined);

console.log('\n4. Global cooldown');
llmCooldown.clear();
check('starts clear', llmCooldown.remainingSeconds() === 0);

// Keyed by provider, so the checks have to name the one that the default
// remainingSeconds() query - the smart model, which is what the evaluation
// queue waits on - actually consults.
const smartProvider = providerOf(SMART_MODEL);
const fastProvider = providerOf(FAST_MODEL);

llmCooldown.engage(120, smartProvider);
const remaining = llmCooldown.remainingSeconds();
console.log(`   engaged ${smartProvider}: ${remaining}s remaining`);
check('engaging pauses model calls', remaining > 115 && remaining <= 120);

llmCooldown.engage(30, smartProvider);
check('a shorter cooldown never shortens an active one', llmCooldown.remainingSeconds() > 115);

llmCooldown.engage(600, smartProvider);
check('a longer cooldown extends it', llmCooldown.remainingSeconds() > 590);

// The whole point of the split routing: one provider running out of quota
// must not pause the other one's work.
if (fastProvider !== smartProvider) {
  check(
    `${fastProvider} keeps working while ${smartProvider} is blocked`,
    llmCooldown.remainingSeconds(FAST_MODEL) === 0,
  );
} else {
  console.log(`  SKIP  both roles run on ${smartProvider}, so there is no isolation to check`);
}

llmCooldown.clear();
check('clearing resumes normal calls', llmCooldown.remainingSeconds() === 0);

console.log(failures.length === 0 ? '\nRATE LIMIT HANDLING OK' : `\n${failures.length} CHECK(S) FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
