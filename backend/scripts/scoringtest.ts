/**
 * Checks the overall rating is the mean of the two halves the report shows.
 *
 * Soft is communication with behavioural, hard is technical with coding. The
 * two partners inside a half count equally, and when one of them was never
 * evaluated the other carries the whole half rather than being averaged
 * against a zero it did not earn. The same one level up: a half with nothing
 * in it leaves the other half as the entire score.
 *
 * The consequence is deliberate, and pinned below rather than left to be
 * rediscovered. Because an unanswered dimension is treated exactly like one
 * that was never asked, leaving it unanswered scores higher than answering it
 * badly. That is the price of never charging a candidate for a dimension the
 * interview did not measure.
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
  communication: number | null;
  behavioral: number | null;
  technical: number | null;
  coding: number | null;
}

/** Mirrors EvaluationService. */
function score(s: Scores) {
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const half = (a: number | null, b: number | null) => {
    const got = [a, b].filter((n): n is number => n != null);
    return got.length ? round1(mean(got)) : null;
  };

  const soft = half(s.communication, s.behavioral);
  const hard = half(s.technical, s.coding);
  const halves = [soft, hard].filter((n): n is number => n != null);

  return { soft, hard, overall: halves.length ? round1(Math.max(0, Math.min(10, mean(halves)))) : 0 };
}

console.log('1. The report that prompted this');

// rk5061288@gmail.com: communication 5.8, technical 3.5, coding 9.6, and a
// behavioural score the judge could not produce at all.
const real = score({ communication: 5.8, behavioral: null, technical: 3.5, coding: 9.6 });
console.log(`     soft ${real.soft}   hard ${real.hard}   overall ${real.overall}`);
check('communication carries the soft half alone', real.soft === 5.8);
check('technical and coding share the hard half', real.hard === 6.6);
check('the overall is the mean of the two halves', real.overall === round1((real.soft! + real.hard!) / 2));
check('the overall never exceeds both halves', real.overall <= Math.max(real.soft!, real.hard!));
check('it is no longer the old weighted 7.5', real.overall !== 7.5, `now ${real.overall}`);

console.log('');
console.log('2. An unevaluated partner hands its half over, it does not zero it');

const bothSoft = score({ communication: 6, behavioral: 4, technical: 8, coding: 8 });
const soloSoft = score({ communication: 6, behavioral: null, technical: 8, coding: 8 });
check('with both partners the half is their mean', bothSoft.soft === 5);
check('with one, the survivor is the whole half', soloSoft.soft === 6);

const soloHard = score({ communication: 6, behavioral: 6, technical: 8, coding: null });
check('the same on the hard side', soloHard.hard === 8);

const onlySoft = score({ communication: 7, behavioral: 5, technical: null, coding: null });
check('an empty half leaves the other as the entire score', onlySoft.overall === 6, `hard ${onlySoft.hard}`);

console.log('');
console.log('3. The deliberate trade');

// Not answering is treated exactly like never being asked, so it scores above
// answering badly. Pinned so that changing it shows up as a diff here rather
// than as a surprise in somebody's report.
const base = { communication: 5.8, behavioral: 4, technical: 3.5, coding: 9.6 };

const withheldBehavioral = score({ ...base, behavioral: null }).overall;
const badBehavioral = score({ ...base, behavioral: 2 }).overall;
check(
  'withholding a behavioural answer beats answering badly, by design',
  withheldBehavioral > badBehavioral,
  `withheld ${withheldBehavioral} vs weak ${badBehavioral}`,
);

const noSubmission = score({ ...base, coding: null }).overall;
const badSubmission = score({ ...base, coding: 2 }).overall;
check(
  'submitting nothing beats submitting bad code, by design',
  noSubmission > badSubmission,
  `nothing ${noSubmission} vs bad ${badSubmission}`,
);

// Within the answers a candidate does give, a better one must never score
// worse. This is the property the trade above must not be allowed to break.
let monotonic = true;
for (let v = 0.5; v <= 10; v += 0.5) {
  if (score({ ...base, coding: v }).overall < score({ ...base, coding: v - 0.5 }).overall) monotonic = false;
}
check('among scored answers, a better one never lowers the overall', monotonic);

console.log('');
console.log('4. Bounds');
const best = score({ communication: 10, behavioral: 10, technical: 10, coding: 10 });
const worst = score({ communication: 0, behavioral: null, technical: null, coding: null });
const nothing = score({ communication: null, behavioral: null, technical: null, coding: null });
check('a perfect interview scores 10', best.overall === 10);
check('a scored-zero interview scores 0', worst.overall === 0);
check('an interview with nothing measured at all scores 0', nothing.overall === 0);

console.log('');
console.log(failures.length ? `${failures.length} CHECK(S) FAILED` : 'SCORING OK');
process.exit(failures.length ? 1 : 0);
