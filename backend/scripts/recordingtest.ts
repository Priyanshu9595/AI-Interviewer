/**
 * Proves an interview recording survives the ways it previously did not:
 * streamed in chunks, assembled server-side, and playable without an
 * Authorization header (a <video> element cannot send one).
 */
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

/** One MediaRecorder-sized blob. */
const chunk = (n: number) => Buffer.alloc(3000, 0x40 + (n % 26));

async function sendChunk(accessToken: string, data: Buffer) {
  const form = new FormData();
  form.append('chunk', new Blob([data], { type: 'video/webm' }), 'chunk.webm');
  const res = await fetch(`${API}/api/interview/${accessToken}/recording/chunk`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`chunk upload failed: ${res.status}`);
  return (await res.json()) as { bytes: number };
}

async function makeInterview(title: string) {
  const session = (await call('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      title,
      jobDescription: 'A short session used to verify that interview recordings stream, assemble and play back.',
      skills: ['Testing'],
      experienceLevel: 'Mid-level (3-5 years)',
      type: 'HR',
      scheduledAt: new Date(Date.now() - 5_000).toISOString(),
      durationMinutes: 15,
      codingEnabled: false,
      recordingEnabled: true,
      videoAnalysisEnabled: false,
      generateQuestions: false,
    }),
  })) as { id: string };

  const invited = (await call(`/api/sessions/${session.id}/candidates`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Recording Tester', email: `rec-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.com` }),
  })) as { id: string; accessToken: string };

  return { sessionId: session.id, invited };
}

(async () => {
  console.log('1. Login');
  token = ((await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'recruiter@demo.com', password: 'demo1234' }),
  })) as { accessToken: string }).accessToken;

  // ---------------------------------------------------------------------
  console.log('\n2. Normal interview: stream chunks, then finalise');
  const a = await makeInterview('Recording — normal finish');

  let total = 0;
  for (let i = 0; i < 5; i++) {
    const res = await sendChunk(a.invited.accessToken, chunk(i));
    total = res.bytes;
  }
  console.log(`   streamed 5 chunks, server holds ${total} bytes`);
  check('chunks accumulate server-side', total === 15_000);

  await call(`/api/interview/${a.invited.accessToken}/recording/finalise`, {
    method: 'POST',
    body: JSON.stringify({ durationSeconds: 25, mimeType: 'video/webm' }),
  });

  const info = (await call(`/api/interviews/${a.invited.id}/recording`)) as {
    url: string;
    sizeBytes: number;
    durationSeconds: number;
  };
  check('the recording was stored', info.sizeBytes === 15_000);
  check('duration was kept', info.durationSeconds === 25);

  console.log('\n3. Play it back with NO Authorization header (as a <video> does)');
  const playback = await fetch(info.url);
  const body = Buffer.from(await playback.arrayBuffer());
  console.log(`   ${playback.status} ${playback.headers.get('content-type')} ${body.length} bytes`);
  check('playback works without auth', playback.ok && body.length === 15_000);
  check('range seeking is advertised', playback.headers.get('accept-ranges') === 'bytes');

  const ranged = await fetch(info.url, { headers: { Range: 'bytes=0-99' } });
  check('a range request returns 206', ranged.status === 206);
  check('only the requested bytes come back', (await ranged.arrayBuffer()).byteLength === 100);

  // ---------------------------------------------------------------------
  console.log('\n4. Abandoned interview: chunks arrive, then the tab closes');
  const b = await makeInterview('Recording — abandoned tab');

  for (let i = 0; i < 4; i++) await sendChunk(b.invited.accessToken, chunk(i));
  console.log('   streamed 4 chunks, then the client vanishes (no finalise call)');

  // This is what the socket layer does when the interview ends without the
  // client ever asking to finalise.
  const salvaged = (await call(`/api/interview/${b.invited.accessToken}/recording/finalise`, {
    method: 'POST',
    body: JSON.stringify({ durationSeconds: 0 }),
  })) as { stored: boolean; sizeBytes?: number };

  console.log(`   server-side finalise: stored=${salvaged.stored} ${salvaged.sizeBytes ?? 0} bytes`);
  check('an abandoned interview still yields a recording', salvaged.stored === true);
  check('every chunk received was kept', salvaged.sizeBytes === 12_000);

  // ---------------------------------------------------------------------
  console.log('\n5. Guards');
  const forged = await fetch(`${API}/api/recordings/not-a-real-token`);
  check('a forged playback token is refused', forged.status === 403 || forged.status === 401);

  const empty = await makeInterview('Recording — nothing captured');
  const nothing = (await call(`/api/interview/${empty.invited.accessToken}/recording/finalise`, {
    method: 'POST',
    body: JSON.stringify({}),
  })) as { stored: boolean; reason?: string };
  check('finalising with no chunks stores nothing', nothing.stored === false);
  console.log(`   reason: ${nothing.reason}`);

  const list = (await call('/api/recordings')) as Array<{ sessionCandidateId: string }>;
  check('recordings appear in the list', list.some((r) => r.sessionCandidateId === a.invited.id));

  for (const id of [a.sessionId, b.sessionId, empty.sessionId]) {
    await call(`/api/sessions/${id}`, { method: 'DELETE' }).catch(() => {});
  }
  console.log('\ncleaned up test sessions');

  console.log(failures.length === 0 ? '\nRECORDING OK' : `\n${failures.length} CHECK(S) FAILED`);
  process.exit(failures.length === 0 ? 0 : 1);
})().catch((err) => {
  console.error('RECORDING TEST FAILED:', err.message);
  process.exit(1);
});
