/**
 * Drives the real AnswerSettler through the event sequences Deepgram produces.
 *
 * The behaviour being protected: the interviewer must not reply into a pause.
 * A candidate who stops for a second and carries on has given one answer, not
 * two, and must not be talked over in between.
 *
 * Runs against the same class both the meeting bot and the browser room use,
 * with a short hold so the suite finishes in about a second.
 *
 *   npm run verify:settle
 */
import { AnswerSettler, type SettledAnswer } from '../src/services/AnswerSettler';

const HOLD = 60;
const failures: string[] = [];

const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function make() {
  const settled: SettledAnswer[] = [];
  const settler = new AnswerSettler(HOLD, (a) => settled.push(a));
  return { settler, settled };
}

async function main() {
  console.log('1. One answer, said straight through');
  {
    const { settler, settled } = make();
    settler.addFinal('I used Redis for the session store.', 0.95);
    settler.endOfTurn();

    await wait(HOLD * 0.5);
    check('nothing is submitted while the wait is still running', settled.length === 0);

    await wait(HOLD);
    check('it is submitted once the silence holds', settled.length === 1);
    check('with the text intact', settled[0]?.text === 'I used Redis for the session store.');
  }

  console.log('');
  console.log('2. A pause mid-answer — the case this exists for');
  {
    const { settler, settled } = make();
    settler.addFinal('I used Redis', 0.95);
    settler.endOfTurn();

    // They were only thinking. Carry on before the wait elapses.
    await wait(HOLD * 0.6);
    check('not submitted yet, mid-pause', settled.length === 0);

    settler.addFinal('for the session store.', 0.93);
    await wait(HOLD * 0.6);
    check('still not submitted — the wait restarted when they resumed', settled.length === 0);

    settler.endOfTurn();
    await wait(HOLD * 1.5);
    check('submitted once for the whole thing', settled.length === 1);
    check(
      'both halves joined into one answer',
      settled[0]?.text === 'I used Redis for the session store.',
      settled[0]?.text,
    );
  }

  console.log('');
  console.log('3. An interim alone keeps the turn open');
  {
    const { settler, settled } = make();
    settler.addFinal('So the tricky part', 0.9);
    settler.endOfTurn();

    await wait(HOLD * 0.6);
    settler.addInterim(); // heard breathing into the next word
    await wait(HOLD * 0.6);
    check('an interim inside the window restarts the wait', settled.length === 0);

    await wait(HOLD);
    check('and it settles once they really stop', settled.length === 1);
  }

  console.log('');
  console.log('4. Deepgram announcing the end twice must not double the wait');
  {
    const { settler, settled } = make();
    const startedAt = Date.now();
    settler.addFinal('Yes.', 0.97);

    settler.endOfTurn(); // speech_final
    await wait(HOLD * 0.5);
    settler.endOfTurn(); // utteranceEnd, on Deepgram's longer silence

    await wait(HOLD * 0.8);
    const elapsed = Date.now() - startedAt;
    check(
      'submitted on the first wait, not pushed out by the second',
      settled.length === 1 && elapsed < HOLD * 2,
      `${elapsed}ms elapsed, hold is ${HOLD}ms`,
    );
  }

  console.log('');
  console.log('5. Latency is measured to when they stopped, not to when we did');
  {
    const { settler, settled } = make();
    const before = Date.now();
    settler.addFinal('Done.', 0.95);
    const spokeAt = Date.now();
    settler.endOfTurn();

    await wait(HOLD * 2);
    const heard = settled[0]?.lastHeardAt ?? 0;
    check(
      'lastHeardAt is when they spoke, not when the wait elapsed',
      heard >= before && heard <= spokeAt + 5,
      `heard ${heard - before}ms in, settled ~${HOLD}ms later`,
    );
  }

  console.log('');
  console.log('6. Housekeeping');
  {
    const { settler, settled } = make();
    settler.addFinal('Half a thought', 0.9);
    settler.endOfTurn();
    settler.discard();
    await wait(HOLD * 2);
    check('discard cancels the wait and drops the text', settled.length === 0);
  }
  {
    const { settler, settled } = make();
    settler.endOfTurn(); // nothing buffered
    await wait(HOLD * 2);
    check('an end of turn with nothing said submits nothing', settled.length === 0);
  }
  {
    const { settler, settled } = make();
    settler.addFinal('Something', 0.9);
    settler.endOfTurn();
    settler.cancel();
    await wait(HOLD * 2);
    check('cancel stops the wait without submitting', settled.length === 0);
  }
  {
    const { settler, settled } = make();
    settler.addFinal('First answer.', 0.9);
    settler.endOfTurn();
    await wait(HOLD * 2);
    settler.addFinal('Second answer.', 0.9);
    settler.endOfTurn();
    await wait(HOLD * 2);
    check('consecutive turns do not bleed into each other', settled.length === 2);
    check('and the second carries only its own text', settled[1]?.text === 'Second answer.', settled[1]?.text);
  }

  console.log('');
  console.log(failures.length ? `${failures.length} CHECK(S) FAILED` : 'SETTLE OK');
  process.exit(failures.length ? 1 : 0);
}

void main();
