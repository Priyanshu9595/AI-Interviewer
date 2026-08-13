/**
 * Confirms the resume file itself lives in Postgres and comes back byte-identical.
 */
import PDFDocument from 'pdfkit';
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

function makeResumePdf(): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    doc.fontSize(18).text('Anita Desai');
    doc.fontSize(10).text('Full Stack Engineer | anita@example.com');
    doc.moveDown();
    doc.fontSize(12).text('EXPERIENCE');
    doc.fontSize(10).list([
      'Senior Engineer at CloudCo (2020 - Present): built a React and Node platform serving 20,000 daily users.',
      'Reduced API latency by 60 percent by adding a Redis cache layer and batching database reads.',
      'Led the migration from JavaScript to TypeScript across eleven services.',
    ]);
    doc.moveDown();
    doc.fontSize(12).text('SKILLS');
    doc.fontSize(10).text('React, Node.js, TypeScript, PostgreSQL, Redis, Docker');
    doc.end();
  });
}

(async () => {
  console.log('1. Login and create an open session');
  token = ((await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'recruiter@demo.com', password: 'demo1234' }),
  })) as { accessToken: string }).accessToken;

  const session = (await call('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Resume Storage Check',
      jobDescription: 'A session used to verify that uploaded resumes are stored in Postgres and served back intact.',
      skills: ['React', 'Node.js', 'TypeScript', 'Kubernetes'],
      experienceLevel: 'Senior (5-8 years)',
      type: 'TECHNICAL',
      scheduledAt: new Date(Date.now() - 5_000).toISOString(),
      durationMinutes: 30,
      codingEnabled: false,
      videoAnalysisEnabled: false,
      generateQuestions: false,
    }),
  })) as { id: string };

  const invited = (await call(`/api/sessions/${session.id}/candidates`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Anita Desai', email: `resume-${Date.now()}@example.com` }),
  })) as { id: string; accessToken: string };

  console.log('2. Upload a real PDF as the candidate');
  const pdf = await makeResumePdf();
  console.log(`   generated ${pdf.length} byte PDF`);

  const form = new FormData();
  form.append('resume', new Blob([pdf], { type: 'application/pdf' }), 'anita-desai.pdf');

  const res = await fetch(`${API}/api/interview/${invited.accessToken}/resume`, { method: 'POST', body: form });
  const raw = await res.text();

  if (!res.ok) {
    console.log(`   upload returned ${res.status}: ${raw.slice(0, 300)}`);
  }

  const uploaded = (res.ok ? JSON.parse(raw) : {}) as {
    skills?: string[];
    tailoredQuestions?: number;
    characters?: number;
    analysisPending?: boolean;
  };

  console.log(`   parsed ${uploaded.characters ?? 0} chars, skills: ${(uploaded.skills ?? []).slice(0, 6).join(', ')}`);
  check('upload succeeded', res.ok);
  if (uploaded.analysisPending) {
    console.log('   NOTE: the LLM was unavailable, so analysis is deferred — the file must still be stored.');
  } else {
    check('skills were extracted', (uploaded.skills?.length ?? 0) > 0);
  }

  console.log('\n3. The bytes are in Postgres, not on disk');
  const row = await prisma.sessionCandidate.findUnique({
    where: { id: invited.id },
    select: { resumeFile: true, resumeMimeType: true, resumeSizeBytes: true, resumeFileName: true },
  });

  console.log(`   column resumeFile holds ${row?.resumeFile?.length ?? 0} bytes (${row?.resumeMimeType})`);
  check('the file is stored in the database', (row?.resumeFile?.length ?? 0) === pdf.length);
  check('the size column matches', row?.resumeSizeBytes === pdf.length);
  check('the mime type was kept', row?.resumeMimeType === 'application/pdf');
  check('the original filename was kept', row?.resumeFileName === 'anita-desai.pdf');

  const stored = Buffer.from(row!.resumeFile!);
  check('the stored bytes are identical to what was uploaded', stored.equals(pdf));

  console.log('\n4. Download it back through the API');
  const download = await fetch(`${API}/api/interviews/${invited.id}/resume/file`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const back = Buffer.from(await download.arrayBuffer());

  console.log(`   ${download.status} ${download.headers.get('content-type')} ${back.length} bytes`);
  check('the download round-trips byte for byte', back.equals(pdf));
  check('it is served as a PDF', download.headers.get('content-type') === 'application/pdf');

  const unauth = await fetch(`${API}/api/interviews/${invited.id}/resume/file`);
  check('an unauthenticated download is refused', unauth.status === 401);

  console.log('\n5. The parsed profile is queryable in Postgres');
  if (uploaded.analysisPending) {
    console.log('   skipped: analysis deferred while the LLM quota is exhausted');
  } else {
    const meta = (await call(`/api/interviews/${invited.id}/resume`)) as {
      resumeProfile: { skills: string[]; missingJdSkills: string[] };
    };
    console.log(`   missing JD skills: ${meta.resumeProfile.missingJdSkills.join(', ') || '(none)'}`);
    check('the profile is stored and returned', meta.resumeProfile.skills.length > 0);
    check('a JD skill absent from the resume is flagged', meta.resumeProfile.missingJdSkills.length > 0);
  }

  await call(`/api/sessions/${session.id}`, { method: 'DELETE' });
  console.log('\ncleaned up the test session');

  console.log(failures.length === 0 ? '\nRESUME IN POSTGRES OK' : `\n${failures.length} CHECK(S) FAILED`);
  process.exit(failures.length === 0 ? 0 : 1);
})().catch((err) => {
  console.error('RESUME DB TEST FAILED:', err.message);
  process.exit(1);
});
