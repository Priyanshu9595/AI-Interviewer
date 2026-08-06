import { CodeAnalysisService } from '../src/services/CodeAnalysisService';
import { CodeExecutorService } from '../src/services/CodeExecutorService';

const NL = String.fromCharCode(10);

const PROBLEM =
  'Given a list of integers on the first line and a target on the second line, print the indices of the two numbers that add up to the target, separated by a space.';

const TESTS = [
  { input: `2 7 11 15${NL}9`, output: '0 1' },
  { input: `3 2 4${NL}6`, output: '1 2' },
  { input: `3 3${NL}6`, output: '0 1', hidden: true },
  // 3 (index 3) + 9 (index 4) = 12
  { input: `1 5 8 3 9${NL}12`, output: '3 4', hidden: true },
];

// Optimal: single pass with a hash map.
const OPTIMAL = `
const nums = readInts();
const target = Number(readline());
const seen = new Map();
for (let i = 0; i < nums.length; i++) {
  const need = target - nums[i];
  if (seen.has(need)) { console.log(seen.get(need) + ' ' + i); break; }
  seen.set(nums[i], i);
}`;

// Correct but quadratic — should be marked as not matching optimal.
const BRUTE_FORCE = `
const nums = readInts();
const target = Number(readline());
outer:
for (let i = 0; i < nums.length; i++) {
  for (let j = i + 1; j < nums.length; j++) {
    if (nums[i] + nums[j] === target) { console.log(i + ' ' + j); break outer; }
  }
}`;

// Wrong answer.
const BROKEN = `console.log('0 0');`;

async function grade(label: string, code: string) {
  const execution = await CodeExecutorService.execute('javascript', code, TESTS);

  const review = await CodeAnalysisService.review({
    problem: PROBLEM,
    code,
    language: 'javascript',
    execution,
    optimalTime: 'O(n)',
    optimalSpace: 'O(n)',
  });

  const scored = CodeAnalysisService.score(execution, review);

  console.log(`\n--- ${label} ---`);
  console.log(`  correctness   : ${execution.passed}/${execution.total} tests  (score ${scored.correctness})`);
  console.log(`  time          : ${review.timeComplexity}`);
  console.log(`  space         : ${review.spaceComplexity}`);
  console.log(`  matchesOptimal: ${review.matchesOptimal}`);
  console.log(`  quality       : ${review.qualityScore}/10   readability ${review.readability}/10`);
  console.log(`  OVERALL       : ${scored.overall}/10`);
  console.log(`  feedback      : ${review.feedback.slice(0, 140)}`);
  if (review.improvements.length) console.log(`  improvements  : ${review.improvements.slice(0, 2).join(' | ')}`);

  return { execution, review, scored };
}

(async () => {
  const optimal = await grade('OPTIMAL (hash map, O(n))', OPTIMAL);
  const brute = await grade('BRUTE FORCE (nested loop, O(n^2))', BRUTE_FORCE);
  const broken = await grade('BROKEN (wrong output)', BROKEN);

  console.log('\n=== assertions ===');
  const checks: Array<[string, boolean]> = [
    ['optimal passes every test', optimal.execution.passed === TESTS.length],
    ['brute force passes every test', brute.execution.passed === TESTS.length],
    ['broken fails tests', broken.execution.passed < TESTS.length],
    ['broken scores below the brute force', broken.scored.overall < brute.scored.overall],
    ['a failing submission cannot score above 4 for quality', broken.review.qualityScore <= 4],
    ['hidden tests were executed', optimal.execution.cases.filter((c) => c.hidden).length === 2],
  ];

  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) failed++;
  }

  console.log(failed === 0 ? '\nCODING ASSESSMENT OK' : `\n${failed} CHECK(S) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('CODING TEST FAILED:', err.message);
  process.exit(1);
});
