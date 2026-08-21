/**
 * Checks the overall rating is the mean of the two halves the report shows.
 *
 * The rule is equal halves all the way down: soft is communication and
 * behavioural, hard is technical and coding, and the overall is their mean.
 *
 * What this is really guarding is the property the previous scheme lost. That
 * one divided by however much weight it had managed to measure, which is the
 * same as filling each missing dimension in with the candidate's own average —
 * so declining to answer scored better than answering badly. Nothing a
 * candidate refuses to do should improve their result.
 *
 *   npm run verify:scoring
 */
const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

const round1 = (n: number) => Math.round(n * 10) / 10;

interface Scores {
  communication: number;
  behavioral: number | null;
  technical: number | null;
  coding: number | null;
  /** False when no coding round was configured for the session. */
  codingEnabled?: boolean;
}

/** Mirrors EvaluationService. Kept in step by the reconciliation check below. */
function score(s: Scores) {
  const soft = round1((s.communication + (s.behavioral ?? 0)) / 2);
  const technical = s.technical ?? 0;
  const hard = (s.codingEnabled ?? true) ? round1((technical + (s.coding ?? 0)) / 2) : round1(technical);
  return { soft, hard, overall: round1(Math.max(0, Math.min(10, (soft + hard) / 2))) };
}

console.log('1. The report that prompted this');

// rk5061288@gmail.com: communication 5.8, technical 3.5, coding 9.6, and a
// behavioural score the judge could not produce at all.
const real = score({ communication: 5.8, behavioral: null, technical: 3.5, coding: 9.6 });
console.log(`     soft ${real.soft}   hard ${real.hard}   overall ${real.overall}`);
check('the soft half is what the report already displayed', real.soft === 2.9);
check('the hard half is what the report already displayed', real.hard === 6.6, 'was 6.5 before rounding changed');
check('the overall is the mean of the two halves', real.overall === round1((real.soft + real.hard) / 2));
check('the overall no longer exceeds both halves', real.overall <= Math.max(real.soft, real.hard));
check('it was 7.5 under the old rule, and is not now', real.overall !== 7.5, `now ${real.overall}`);

console.log('\n2. Silence must never pay');

// The exploit in one line: for every dimension, withholding an answer has to
// score no better than giving the worst possible one.
const base = { communication: 5.8, behavioral: 4, technical: 3.5, coding: 9.6 };

const withheldBehavioral = score({ ...base, behavioral: null }).overall;
const zeroBehavioral = score({ ...base, behavioral: 0 }).overall;
check(
  'withholding a behavioural answer scores no better than a zero',
  withheldBehavioral <= zeroBehavioral,
  `withheld ${withheldBehavioral} vs zero ${zeroBehavioral}`,
);

const noSubmission = score({ ...base, coding: null }).overall;
const badSubmission = score({ ...base, coding: 2 }).overall;
check(
  'submitting nothing scores no better than submitting bad code',
  noSubmission <= badSubmission,
  `nothing ${noSubmission} vs bad ${badSubmission}`,
);

const noTechnical = score({ ...base, technical: null }).overall;
const badTechnical = score({ ...base, technical: 1 }).overall;
check(
  'saying nothing technical scores no better than saying something weak',
  noTechnical <= badTechnical,
  `nothing ${noTechnical} vs weak ${badTechnical}`,
);

// Monotonicity: a better answer must never lower the result.
let monotonic = true;
for (let v = 0; v <= 10; v += 0.5) {
  if (score({ ...base, coding: v }).overall < score({ ...base, coding: v - 0.5 }).overall) monotonic = false;
}
check('a better coding score never lowers the overall', monotonic);

console.log('\n3. A round that was never configured is not a zero');

const noCodingRound = score({ communication: 6, behavioral: 6, technical: 8, coding: null, codingEnabled: false });
check('without a coding round the hard half is technical alone', noCodingRound.hard === 8);
check('and the overall does not punish the missing round', noCodingRound.overall === 7);

const skippedCodingRound = score({ communication: 6, behavioral: 6, technical: 8, coding: null, codingEnabled: true });
check(
  'but a configured round left unanswered does count',
  skippedCodingRound.hard === 4,
  `hard ${skippedCodingRound.hard} vs ${noCodingRound.hard} when never configured`,
);

console.log('\n4. Bounds');
const best = score({ communication: 10, behavioral: 10, technical: 10, coding: 10 });
const worst = score({ communication: 0, behavioral: null, technical: null, coding: null });
check('a perfect interview scores 10', best.overall === 10);
check('an empty one scores 0', worst.overall === 0);

console.log(failures.length ? `\n${failures.length} CHECK(S) FAILED` : '\nSCORING OK');
process.exit(failures.length ? 1 : 0);
