/**
 * Checks the join gate: the room does not open early, and an unused link stops
 * working NO_SHOW_GRACE_MINUTES after the scheduled start.
 */
import { evaluateJoinGate } from '../src/services/JoinGate';
import { env } from '../src/lib/env';

const grace = env.NO_SHOW_GRACE_MINUTES;
const at = (minutesFromStart: number) => new Date(Date.now() + minutesFromStart * 60_000);

// The interview is scheduled for "now"; each case moves the clock instead.
const scheduledAt = new Date();

const cases: Array<{
  name: string;
  now: Date;
  joinedAt: Date | null;
  candidateStatus: 'INVITED' | 'IN_PROGRESS' | 'COMPLETED' | 'ABSENT';
  expect: string;
}> = [
  { name: 'an hour early', now: at(-60), joinedAt: null, candidateStatus: 'INVITED', expect: 'TOO_EARLY' },
  { name: '2 minutes early', now: at(-2), joinedAt: null, candidateStatus: 'INVITED', expect: 'TOO_EARLY' },
  { name: '30 seconds early (clock skew)', now: at(-0.5), joinedAt: null, candidateStatus: 'INVITED', expect: 'OPEN' },
  { name: 'exactly on time', now: at(0), joinedAt: null, candidateStatus: 'INVITED', expect: 'OPEN' },
  { name: 'a minute late', now: at(1), joinedAt: null, candidateStatus: 'INVITED', expect: 'OPEN' },
  {
    name: `just inside the ${grace}-minute grace`,
    now: at(grace - 0.5),
    joinedAt: null,
    candidateStatus: 'INVITED',
    expect: 'OPEN',
  },
  {
    name: `just past the ${grace}-minute grace`,
    now: at(grace + 0.5),
    joinedAt: null,
    candidateStatus: 'INVITED',
    expect: 'EXPIRED',
  },
  { name: 'an hour late', now: at(60), joinedAt: null, candidateStatus: 'INVITED', expect: 'EXPIRED' },
  {
    name: 'already joined, now reconnecting long after',
    now: at(60),
    joinedAt: at(1),
    candidateStatus: 'IN_PROGRESS',
    expect: 'OPEN',
  },
  { name: 'already completed', now: at(1), joinedAt: at(0), candidateStatus: 'COMPLETED', expect: 'ALREADY_COMPLETED' },
  { name: 'marked absent', now: at(1), joinedAt: null, candidateStatus: 'ABSENT', expect: 'MARKED_ABSENT' },
];

console.log(`Scheduled at: ${scheduledAt.toLocaleTimeString()}   grace: ${grace} min\n`);

let failed = 0;

for (const c of cases) {
  const result = evaluateJoinGate(
    {
      scheduledAt,
      sessionStatus: 'ACTIVE',
      candidateStatus: c.candidateStatus,
      joinedAt: c.joinedAt,
    },
    c.now,
  );

  const ok = result.verdict === c.expect;
  if (!ok) failed++;

  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(38)} -> ${result.verdict}${ok ? '' : ` (expected ${c.expect})`}`,
  );
}

// A cancelled session overrides everything else.
const cancelled = evaluateJoinGate(
  { scheduledAt, sessionStatus: 'CANCELLED', candidateStatus: 'INVITED', joinedAt: null },
  at(0),
);
const cancelOk = cancelled.verdict === 'CANCELLED' && !cancelled.canJoin;
if (!cancelOk) failed++;
console.log(`  ${cancelOk ? 'PASS' : 'FAIL'}  ${'cancelled session'.padEnd(38)} -> ${cancelled.verdict}`);

console.log(`\nExpiry is exposed to the client as expiresAt = ${evaluateJoinGate({ scheduledAt, sessionStatus: 'ACTIVE', candidateStatus: 'INVITED', joinedAt: null }).expiresAt.toLocaleTimeString()}`);

console.log(failed === 0 ? '\nJOIN GATE OK' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
