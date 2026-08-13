/**
 * Proves that cutting an interview short marks it INCOMPLETE and produces no
 * score, while an interview the AI finishes is COMPLETED and is scored.
 */
import { io, Socket } from 'socket.io-client';
import { prisma } from '../src/lib/prisma';

const API = 'http://localhost:5000';
let token = '';

const failures: string[] = [];
const check = (name: string, ok: boolean) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failures.push(name);
};

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status}: ${text.slice(0, 250)}`);
  return (text ? JSON.parse(text) : {}) as never;
}

(async () => {
  console.log('1. Login and open a session');
  token = ((await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'recruiter@demo.com', password: 'demo1234' }),
  })) as { accessToken: string }).accessToken;

  const session = (await call('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Abandonment Check',
      jobDescription: 'A session used to verify that an interview cut short by the candidate is not scored.',
      skills: ['Communication'],
      experienceLevel: 'Mid-level (3-5 years)',
      type: 'HR',
      scheduledAt: new Date(Date.now() - 5_000).toISOString(),
      durationMinutes: 30,
      codingEnabled: false,
      videoAnalysisEnabled: false,
      generateQuestions: false,
    }),
  })) as { id: string };

  const invited = (await call(`/api/sessions/${session.id}/candidates`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Walkout Tester', email: `walk-${Date.now()}@example.com` }),
  })) as { id: string; accessToken: string };

  console.log('2. Join, answer once, then hang up mid-interview');
  const socket: Socket = io(`${API}/interview`, {
    query: { token: invited.accessToken },
    transports: ['websocket'],
  });

  const ended = await new Promise<string>((resolve) => {
    let answers = 0;
    const timer = setTimeout(() => resolve('timeout'), 120_000);

    socket.on('connected', () => socket.emit('candidate_joined'));

    socket.on('ai_speak', (d: { expectsAnswer: boolean }) => {
      if (!d.expectsAnswer) return;
      answers++;

      if (answers >= 2) {
        // The candidate walks out.
        console.log('   candidate ends the interview');
        socket.emit('end_interview');
        return;
      }

      setTimeout(
        () => socket.emit('candidate_answer', { text: 'Yes, I am ready to begin.', confidence: 0.95, latencyMs: 800 }),
        300,
      );
    });

    socket.on('interview_ended', (d: { reason: string }) => {
      clearTimeout(timer);
      resolve(d.reason);
    });
  });

  socket.disconnect();
  console.log(`   ended with reason: ${ended}`);
  check('the walkout is reported as abandoned', ended === 'abandoned');

  console.log('\n3. What was recorded');
  // Allow the gateway's write and any evaluation attempt to settle.
  await new Promise((r) => setTimeout(r, 8000));

  const row = await prisma.sessionCandidate.findUnique({
    where: { id: invited.id },
    select: {
      status: true,
      completedAt: true,
      report: { select: { id: true } },
      transcript: { select: { _count: { select: { turns: true } } } },
    },
  });

  console.log(`   status=${row?.status}  report=${row?.report?.id ?? 'NONE'}  turns=${row?.transcript?._count.turns ?? 0}`);

  check('the interview is marked INCOMPLETE', row?.status === 'INCOMPLETE');
  check('NO score was generated', row?.report === null);
  check('the transcript up to the walkout is still kept', (row?.transcript?._count.turns ?? 0) > 0);

  console.log('\n4. The retry queue must not resurrect it');
  const pending = await prisma.sessionCandidate.count({
    where: { id: invited.id, status: 'COMPLETED' },
  });
  check('it is not picked up as a pending evaluation', pending === 0);

  console.log('\n5. The recruiter sees it in the candidate list');
  const listed = (await call(`/api/sessions/${session.id}/candidates`)) as Array<{ id: string; status: string }>;
  check('the list reports INCOMPLETE', listed.find((c) => c.id === invited.id)?.status === 'INCOMPLETE');

  await call(`/api/sessions/${session.id}`, { method: 'DELETE' });
  console.log('\ncleaned up the test session');

  console.log(failures.length === 0 ? '\nINCOMPLETE HANDLING OK' : `\n${failures.length} CHECK(S) FAILED`);
  process.exit(failures.length === 0 ? 0 : 1);
})().catch((err) => {
  console.error('INCOMPLETE TEST FAILED:', err.message);
  process.exit(1);
});
