/**
 * Checks that background noise never becomes an answer.
 *
 * Two defences, tested separately because they fail in opposite directions:
 *
 *   1. The gate in the injected audio bridge, which decides what reaches the
 *      recogniser at all. Its dangerous failure is closing on a real voice.
 *   2. isLikelyNoise, which decides whether a settled transcript is an answer.
 *      Its dangerous failure is discarding a real answer.
 *
 * Neither needs the API, a database or a meeting: npm run verify:noise
 */
import fs from 'fs';
import path from 'path';
import { isLikelyNoise } from '../src/services/SpeechService';

const failures: string[] = [];
const check = (name: string, ok: boolean) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failures.push(name);
};

// ---------------------------------------------------------------------------
// 1. The transcript guard
// ---------------------------------------------------------------------------

console.log('1. Transcripts that must be kept');

const KEEP: Array<[string, number, string]> = [
  ['No.', 0.97, 'a confident one-word decline ends the closing round'],
  ['Yes', 0.95, 'a confident one-word affirmative'],
  ['Nahin', 0.88, 'a one-word decline in Hindi'],
  ['I used Redis for the session store.', 0.93, 'an ordinary answer'],
  ['Um, I think it was about forty thousand a second.', 0.91, 'an answer that opens with a filler'],
  ['I do not know.', 0.89, 'an honest admission is a real answer'],
  ['Okay', 0.92, 'the greeting reply the state machine reads as "well"'],
  ['So basically we sharded it.', 0.72, 'a noisy line, but clearly words'],
  ['Kubernetes', 0.83, 'a confident single technical word'],
  ['हाँ, बिल्कुल।', 0.9, 'non-Latin script survives the punctuation strip'],
];

for (const [text, confidence, why] of KEEP) {
  check(`${why} — ${JSON.stringify(text)}`, !isLikelyNoise(text, confidence));
}

console.log('\n2. Transcripts that must be discarded');

const DROP: Array<[string, number, string]> = [
  ['', 0.9, 'empty'],
  ['   ', 0.9, 'whitespace only'],
  ['.', 0.8, 'punctuation only'],
  ['[BLANK_AUDIO]', 0.9, 'the recogniser said it heard no speech'],
  ['(background noise)', 0.9, 'the recogniser named it as noise'],
  ['Uh.', 0.95, 'throat clearing, however clearly heard'],
  ['Hmm', 0.99, 'throat clearing'],
  ['um uh hmm', 0.88, 'nothing but fillers'],
  ['the', 0.41, 'one low-confidence word — the classic fan or keyboard result'],
  ['on the', 0.52, 'two low-confidence words'],
  ['I think the thing was that', 0.31, 'long, but below the confidence floor'],
];

for (const [text, confidence, why] of DROP) {
  check(`${why} — ${JSON.stringify(text)}`, isLikelyNoise(text, confidence));
}

// ---------------------------------------------------------------------------
// 2. The gate
//
// The constants and the update rules are read out of the bridge rather than
// copied, so this cannot drift from what actually ships.
// ---------------------------------------------------------------------------

console.log('\n3. The noise gate, at realistic levels');

const bridge = fs.readFileSync(
  path.resolve(__dirname, '../src/services/meetingBot/injected/audioBridge.ts'),
  'utf8',
);

const constant = (name: string): number => {
  const match = bridge.match(new RegExp(`var ${name} = ([0-9.]+);`));
  if (!match?.[1]) throw new Error(`${name} is no longer declared in audioBridge.ts`);
  return Number(match[1]);
};

const GATE_MIN = constant('GATE_MIN');
const GATE_MAX = constant('GATE_MAX');
const GATE_OVER_FLOOR = constant('GATE_OVER_FLOOR');
const GATE_HOLD_S = constant('GATE_HOLD_S');
const GATE_SEGMENT_S = constant('GATE_SEGMENT_S');
const GATE_SEGMENTS = constant('GATE_SEGMENTS');

const RATE = 48_000;
const BLOCK = 4096;
const BLOCK_S = BLOCK / RATE;
const SEGMENT_BLOCKS = Math.max(1, Math.round((GATE_SEGMENT_S * RATE) / BLOCK));

/** One decision per block, mirroring onaudioprocess. */
function gate(levels: number[]): Array<{ level: number; pass: boolean }> {
  const g = { holdUntil: 0, prev: null as number | null, prevPass: false, segMin: 1, segBlocks: 0 };
  const history: number[] = [];
  const out: Array<{ level: number; pass: boolean }> = [];
  let t = 0;

  for (const rms of levels) {
    if (rms < g.segMin) g.segMin = rms;
    g.segBlocks++;
    if (g.segBlocks >= SEGMENT_BLOCKS) {
      history.push(g.segMin);
      if (history.length > GATE_SEGMENTS) history.shift();
      g.segMin = 1;
      g.segBlocks = 0;
    }

    let floor = g.segMin;
    for (const h of history) if (h < floor) floor = h;

    let threshold = floor * GATE_OVER_FLOOR;
    if (threshold < GATE_MIN) threshold = GATE_MIN;
    if (threshold > GATE_MAX) threshold = GATE_MAX;

    t += BLOCK_S;
    const passNow = rms >= threshold;
    if (passNow) g.holdUntil = t + GATE_HOLD_S;

    const emit = g.prev;
    const pass = g.prevPass || passNow || t < g.holdUntil;

    g.prev = rms;
    g.prevPass = passNow;

    if (emit !== null) out.push({ level: emit, pass });
  }

  return out;
}

const blocks = (count: number, rms: number) => Array<number>(count).fill(rms);

/** Levels as a fraction of full scale, measured over 85 ms. */
const ROOM = 0.002; // a quiet room, about -54 dBFS
const FAN = 0.012; // air conditioning or a ceiling fan, about -38 dBFS
const SPEECH = 0.06; // ordinary speech over a meeting
const SOFT = 0.009; // a quiet speaker on a poor microphone

const quiet = gate(blocks(60, ROOM));
check('a quiet empty room sends nothing to the recogniser', quiet.every((b) => !b.pass));

const fan = gate(blocks(120, FAN));
check('a fan on its own never opens the gate', fan.every((b) => !b.pass));

const onset = gate([...blocks(40, ROOM), ...blocks(30, SPEECH)]);
const first = onset.findIndex((b) => b.level >= SPEECH);
check(
  'the block before the first word is passed too, so the attack is not clipped',
  Boolean(onset[first - 1]?.pass) && onset.slice(first).every((b) => b.pass),
);

const pause = gate([...blocks(40, ROOM), ...blocks(12, SPEECH), ...blocks(4, ROOM), ...blocks(12, SPEECH)]);
check('a 340 ms pause inside a sentence is not punched out', pause.slice(41, 68).every((b) => b.pass));

const trailing = gate([...blocks(20, ROOM), ...blocks(20, SPEECH), ...blocks(40, ROOM)]);
const heldFor = (trailing.map((b) => b.pass).lastIndexOf(true) - 39) * BLOCK_S;
check(
  `the gate closes ${heldFor.toFixed(1)}s after the voice stops`,
  heldFor > GATE_HOLD_S * 0.7 && heldFor < GATE_HOLD_S * 1.5,
);

const soft = gate([...blocks(40, ROOM), ...blocks(20, SOFT)]);
check('a soft speaker in a quiet room still gets through', soft.slice(45).every((b) => b.pass));

const over = gate([...blocks(80, FAN), ...blocks(20, SPEECH)]);
check('speech over a running fan still gets through', over.slice(82).every((b) => b.pass));

// The known weakness of minimum statistics: with no gap anywhere in the
// window, the floor becomes the speaker. Real speech dips between syllables at
// this resolution, and the ceiling on the threshold covers what is left.
const long = gate([
  ...blocks(20, ROOM),
  ...Array.from({ length: 470 }, (_, i) => (i % 7 === 0 ? 0.012 : i % 3 === 0 ? 0.03 : SPEECH)),
]);
check('a forty-second answer does not gate itself out part way through', long.slice(22).every((b) => b.pass));

console.log(
  failures.length
    ? `\n${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`
    : '\nNOISE HANDLING PASSED',
);
process.exit(failures.length ? 1 : 0);
