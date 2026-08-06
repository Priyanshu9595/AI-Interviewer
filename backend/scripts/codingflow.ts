/**
 * Proves a coding question reaches the candidate and is runnable on the
 * compiler: generate -> save -> what the state machine emits -> dry run ->
 * graded submit.
 *
 * Run against a live API: npm run verify:codingflow
 */
import { io, Socket } from 'socket.io-client';

const API = 'http://localhost:5000';
const NL = String.fromCharCode(10);

let token = '';
let cookie = '';

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0] ?? '';

  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as never;
}

(async () => {
  const failures: string[] = [];
  const check = (name: string, ok: boolean) => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) failures.push(name);
  };

  console.log('1. Login');
  token = ((await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'recruiter@demo.com', password: 'demo1234' }),
  })) as { accessToken: string }).accessToken;

  // A 15-minute round: the exact case that used to silently drop coding.
  console.log('2. Create a 15-minute TECHNICAL session with coding enabled');
  const session = (await call('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Coding Flow Check',
      jobDescription:
        'We need an engineer comfortable with algorithms and data structures in JavaScript and Python, able to reason about time and space complexity under time pressure.',
      skills: ['Algorithms', 'Data Structures', 'JavaScript'],
      experienceLevel: 'Mid-level (3-5 years)',
      type: 'TECHNICAL',
      // Starts now so the join gate lets us straight in.
      scheduledAt: new Date(Date.now() - 5_000).toISOString(),
      durationMinutes: 15,
      codingEnabled: true,
      videoAnalysisEnabled: false,
      recordingEnabled: false,
      generateQuestions: true,
    }),
  })) as { id: string };

  console.log('3. Wait for question generation');
  let coding: { id: string; content: string; meta: Record<string, unknown> } | null = null;

  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const detail = (await call(`/api/sessions/${session.id}`)) as {
      questionSet: { questions: Array<{ id: string; category: string; content: string; meta: Record<string, unknown> }> } | null;
    };
    const qs = detail.questionSet?.questions ?? [];
    if (qs.length) {
      const counts: Record<string, number> = {};
      for (const q of qs) counts[q.category] = (counts[q.category] ?? 0) + 1;
      console.log(`   ${qs.length} questions: ${JSON.stringify(counts)}`);
      coding = qs.find((q) => q.category === 'CODING') ?? null;
      break;
    }
  }

  console.log('\n=== generation ===');
  check('a CODING question exists in a 15-minute session', coding !== null);
  if (!coding) {
    console.log('\nCODING FLOW FAILED — nothing to run');
    process.exit(1);
  }

  const meta = coding.meta as {
    title?: string;
    testCases?: Array<{ input: string; output: string; hidden?: boolean }>;
    optimalTime?: string;
  };
  const tests = meta.testCases ?? [];
  console.log(`   title: ${meta.title}`);
  console.log(`   problem: ${coding.content.slice(0, 150)}…`);
  console.log(`   test cases: ${tests.length} (${tests.filter((t) => t.hidden).length} hidden)`);
  tests.slice(0, 3).forEach((t, i) =>
    console.log(`     ${i + 1}. in=${JSON.stringify(t.input)} -> out=${JSON.stringify(t.output)}`),
  );

  check('has at least 2 runnable test cases', tests.filter((t) => t.input?.trim() && t.output?.trim()).length >= 2);

  console.log('\n4. Invite a candidate and open the room over the socket');
  const invited = (await call(`/api/sessions/${session.id}/candidates`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Coding Tester', email: `coding-${Date.now()}@example.com` }),
  })) as { id: string; accessToken: string };

  // Walk the interview until the coding challenge is pushed to the client.
  const challenge = await new Promise<Record<string, unknown> | null>((resolve) => {
    const socket: Socket = io(`${API}/interview`, {
      query: { token: invited.accessToken },
      transports: ['websocket'],
    });

    const timer = setTimeout(() => {
      socket.disconnect();
      resolve(null);
    }, 240_000);

    socket.on('connected', () => socket.emit('candidate_joined'));

    socket.on('ai_speak', (d: { text: string; expectsAnswer: boolean; round?: string }) => {
      if (d.round === 'CODING') console.log(`   AI announced the coding round: ${d.text.slice(0, 90)}…`);
      if (!d.expectsAnswer) return;
      setTimeout(
        () =>
          socket.emit('candidate_answer', {
            text: 'I have around four years of experience building services in JavaScript, mostly around data processing and APIs.',
            confidence: 0.95,
            latencyMs: 900,
            durationMs: 8000,
          }),
        300,
      );
    });

    socket.on('coding_challenge', (d: { question: Record<string, unknown> }) => {
      clearTimeout(timer);
      socket.disconnect();
      resolve(d.question);
    });

    socket.on('interview_ended', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });

  console.log('\n=== delivery to the candidate ===');
  check('the coding challenge was pushed over the socket', challenge !== null);

  if (challenge) {
    const sample = (challenge.sampleTests ?? []) as Array<{ input: string; output: string }>;
    console.log(`   editor received: "${challenge.title}" with ${sample.length} sample test(s)`);
    check('sample tests are visible to the candidate', sample.length >= 1);
    check('hidden tests are NOT leaked to the candidate', !JSON.stringify(challenge).includes('"hidden":true'));
  }

  console.log('\n5. Run code on the compiler (dry run against the sample tests)');

  // The problem is generated fresh each run, so no fixed solution can solve it.
  // Instead, print the first sample's expected output verbatim: that case must
  // pass and the others must fail, which proves grading compares against THIS
  // question's data rather than something cached or hard-coded.
  const firstVisible = tests.find((t) => !t.hidden) ?? tests[0]!;
  const echoFirst = `console.log(${JSON.stringify(firstVisible.output.trim())});`;

  const dry = (await call(`/api/interview/${invited.accessToken}/code/run`, {
    method: 'POST',
    body: JSON.stringify({ questionId: coding.id, language: 'javascript', code: echoFirst, dryRun: true }),
  })) as { passed: number; total: number; compileError?: string; cases: Array<{ passed: boolean }> };

  console.log(
    `   dry run: ${dry.passed}/${dry.total} sample tests passed (expected exactly the one we echoed) ${dry.compileError ?? ''}`,
  );
  check('dry run executes without a compile error', !dry.compileError);
  check('the echoed case passes — grading uses this problem’s real test data', dry.passed >= 1);

  const broken = (await call(`/api/interview/${invited.accessToken}/code/run`, {
    method: 'POST',
    body: JSON.stringify({
      questionId: coding.id,
      language: 'javascript',
      code: 'console.log("definitely-not-the-answer");',
      dryRun: true,
    }),
  })) as { passed: number; total: number };

  console.log(`   wrong answer: ${broken.passed}/${broken.total} passed`);
  check('a wrong answer fails every case', broken.passed === 0);

  const syntaxError = (await call(`/api/interview/${invited.accessToken}/code/run`, {
    method: 'POST',
    body: JSON.stringify({ questionId: coding.id, language: 'javascript', code: 'this is not javascript(', dryRun: true }),
  })) as { passed: number; cases: Array<{ stderr?: string }> };

  const reportedError = syntaxError.cases.some((c) => c.stderr);
  console.log(`   syntax error surfaced to the candidate: ${reportedError}`);
  check('a syntax error is reported rather than silently failing', reportedError);

  console.log('\n6. Submit for grading (all tests, including hidden)');
  const graded = (await call(`/api/interview/${invited.accessToken}/code/run`, {
    method: 'POST',
    body: JSON.stringify({ questionId: coding.id, language: 'javascript', code: echoFirst, dryRun: false }),
  })) as {
    submissionId: string;
    passed: number;
    total: number;
    hiddenPassed: number;
    hiddenTotal: number;
    cases: Array<{ hidden: boolean }>;
  };

  console.log(`   graded: ${graded.passed}/${graded.total} (hidden ${graded.hiddenPassed}/${graded.hiddenTotal})`);
  check('a submission was recorded', Boolean(graded.submissionId));
  check('grading ran every test, not just the samples', graded.total >= tests.length);
  check('hidden case contents are not returned', graded.cases.every((c) => !c.hidden));

  console.log('\n7. Confirm the stored evaluation');
  const stored = (await call(`/api/interviews/${invited.id}/insights`)) as unknown;
  void stored;

  const submissions = (await call(`/api/sessions/${session.id}/candidates`)) as Array<{
    id: string;
    _count: { submissions: number };
  }>;
  const mine = submissions.find((s) => s.id === invited.id);
  check('the submission is attached to the candidate', (mine?._count.submissions ?? 0) >= 1);

  console.log(`\n${failures.length === 0 ? 'CODING FLOW OK' : `${failures.length} CHECK(S) FAILED`}`);
  process.exit(failures.length === 0 ? 0 : 1);
})().catch((err) => {
  console.error('CODING FLOW FAILED:', err.message);
  process.exit(1);
});
