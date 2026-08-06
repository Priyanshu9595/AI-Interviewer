/**
 * End-to-end check: creates a session, invites a candidate, runs the whole
 * interview over Socket.IO as that candidate, then verifies the report.
 */
import { io, Socket } from 'socket.io-client';

const API = 'http://localhost:5000';
const NL = String.fromCharCode(10);

let cookie = '';
let token = '';

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
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
  return body as never;
}

/** Plausible answers so the evaluator has real substance to judge. */
const ANSWERS = [
  "Sure. I'm a backend engineer with about six years of experience, mostly in Node and TypeScript. For the last three years I've owned the payments service at my current company, which handles roughly forty thousand transactions a day. Before that I worked on internal tooling.",
  "Yes, that's right. My name is Priya Sharma and I applied for the Senior Backend Engineer role.",
  "The biggest one was an N+1 query problem in our order listing endpoint. Each order was fetching its line items separately, so a page of fifty orders meant four hundred queries. I found it in the APM traces, then fixed it with a single join and a dataloader in front. P95 went from about two seconds down to a hundred and eighty milliseconds.",
  "I'd start by looking at what actually changed. I'd check the deployment log first, then compare error rates before and after. If it correlates with a deploy I'd roll back immediately rather than debug in production, then reproduce it in staging. Stabilise first, understand second.",
  "We disagreed about whether to use a message queue or just do it synchronously. He wanted the queue for resilience, I thought it was premature. We ended up writing down the actual failure modes we were worried about, and it turned out only one of them was real. We went with synchronous plus a retry, and revisited it six months later when volume justified the queue.",
  "I'd say ownership. On the payments service I was the one who set up the on-call rotation and wrote the runbooks, because nobody else was going to. It wasn't in my job description but the service was going to page someone at three in the morning eventually, and I wanted that person to have a document.",
  "Most recently I taught myself enough about database internals to understand why our index wasn't being used. I read the Postgres query planner documentation and ran EXPLAIN ANALYZE until it made sense. Turned out the planner was choosing a sequential scan because our statistics were stale.",
  "For the project I'm proudest of, it was the payments migration. We moved from a single-table design to a proper double-entry ledger without downtime. I designed the schema and wrote the backfill. What I'd do differently is invest in the reconciliation tooling earlier — we built it after the migration and it would have caught two bugs during, not after.",
  "That's a good question. I think the main thing I'd want to know is how the team makes technical decisions — whether there's an RFC process or if it's more informal.",
];

async function main() {
  console.log('1. Health');
  const health = await call('/health');
  console.log('   ', JSON.stringify(health));

  console.log('2. Login');
  const auth = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'recruiter@demo.com', password: 'demo1234' }),
  });
  token = (auth as { accessToken: string }).accessToken;
  console.log('    ok');

  console.log('3. Create session (coding disabled to keep the run short)');
  const session = await call('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      title: 'E2E Senior Backend Engineer',
      jobDescription:
        'We need a senior backend engineer to own our payments platform, designing high-throughput services in Node.js and TypeScript, modelling data in PostgreSQL, and taking responsibility for reliability, observability and on-call duty.',
      skills: ['Node.js', 'TypeScript', 'PostgreSQL', 'System Design'],
      experienceLevel: 'Senior (5-8 years)',
      type: 'MIXED',
      scheduledAt: new Date(Date.now() + 60_000).toISOString(),
      durationMinutes: 30,
      codingEnabled: false,
      videoAnalysisEnabled: true,
      generateQuestions: true,
    }),
  }) as { id: string };
  console.log('    session', session.id);

  console.log('4. Wait for question generation');
  let questionCount = 0;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const detail = await call(`/api/sessions/${session.id}`) as {
      questionSet: { questions: Array<{ category: string }> } | null;
    };
    questionCount = detail.questionSet?.questions.length ?? 0;
    if (questionCount > 0) {
      const byCategory: Record<string, number> = {};
      for (const q of detail.questionSet!.questions) byCategory[q.category] = (byCategory[q.category] ?? 0) + 1;
      console.log(`    ${questionCount} questions:`, JSON.stringify(byCategory));
      break;
    }
  }
  if (!questionCount) throw new Error('No questions were generated');

  console.log('5. Add candidate');
  const invited = await call(`/api/sessions/${session.id}/candidates`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Priya Sharma', email: `e2e-${Date.now()}@example.com`, mobile: '+91 90000 00001' }),
  }) as { id: string; accessToken: string };
  console.log('    join token', invited.accessToken);

  console.log('6. Verify reminders were queued');
  const withReminders = await call(`/api/sessions/${session.id}/candidates`) as Array<{
    reminders: Array<{ kind: string; status: string }>;
  }>;
  console.log('   ', JSON.stringify(withReminders[0]?.reminders.map((r) => `${r.kind}:${r.status}`)));

  console.log('7. Candidate context');
  const context = await call(`/api/interview/${invited.accessToken}`) as {
    candidate: { name: string };
    interviewer: { name: string };
    gate: { canJoin: boolean; reason: string | null };
  };
  console.log(`    ${context.candidate.name} vs ${context.interviewer.name}, canJoin=${context.gate.canJoin}`);
  if (!context.gate.canJoin) throw new Error(`Gate closed: ${context.gate.reason}`);

  console.log('8. Post video metrics');
  await call(`/api/interview/${invited.accessToken}/video-metrics`, {
    method: 'POST',
    body: JSON.stringify({
      frames: Array.from({ length: 20 }, (_, i) => ({
        facePresence: 0.85 + (i % 3) * 0.04,
        motion: 0.2 + (i % 4) * 0.05,
        gazeStability: 0.7 + (i % 3) * 0.06,
      })),
    }),
  });
  console.log('    20 frames recorded');

  console.log('9. Run the interview over the socket');
  const socket: Socket = io(`${API}/interview`, {
    query: { token: invited.accessToken },
    transports: ['websocket'],
  });

  let answerIndex = 0;
  let aiTurns = 0;
  const rounds = new Set<string>();

  await new Promise<void>((resolve, reject) => {
    // Every turn is a live model call, so a full interview is genuinely slow.
    // This bounds the test, not the product — the state machine has its own hard
    // stop at 1.5x the scheduled duration.
    const failTimer = setTimeout(() => reject(new Error('Interview timed out after 25 minutes')), 1_500_000);

    socket.on('connected', () => socket.emit('candidate_joined'));
    socket.on('error_message', (d: { message: string }) => reject(new Error(d.message)));

    socket.on('insight', (d: { type: string; message: string }) => {
      console.log(`      [signal] ${d.type}: ${d.message}`);
    });

    socket.on('state_change', (d: { state: string; round?: string; progress: number }) => {
      if (d.round) rounds.add(d.round);
    });

    socket.on('ai_speak', (d: { text: string; expectsAnswer: boolean; round?: string }) => {
      aiTurns++;
      console.log(`    AI [${d.round ?? '-'}]: ${d.text.slice(0, 110)}${d.text.length > 110 ? '…' : ''}`);

      if (!d.expectsAnswer) return;

      const answer = ANSWERS[answerIndex % ANSWERS.length] as string;
      answerIndex++;

      // Simulate think-time and speaking time so the analyzers get real signals.
      setTimeout(() => {
        socket.emit('candidate_answer', {
          text: answer,
          confidence: 0.92,
          latencyMs: 900 + Math.round(Math.random() * 1500),
          durationMs: Math.round((answer.split(' ').length / 140) * 60_000),
        });
      }, 400);
    });

    socket.on('interview_ended', (d: { reason: string }) => {
      console.log(`    interview ended: ${d.reason}`);
      clearTimeout(failTimer);
      resolve();
    });
  });

  socket.disconnect();
  console.log(`    ${aiTurns} AI turns, rounds covered: ${Array.from(rounds).join(', ')}`);

  console.log('10. Wait for evaluation');
  let reportId = '';
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const found = await call(`/api/interviews/${invited.id}/report`) as { reportId: string };
      reportId = found.reportId;
      break;
    } catch {
      /* not ready */
    }
  }
  if (!reportId) throw new Error('No report was generated');

  console.log('11. Inspect report');
  const report = await call(`/api/reports/${reportId}`) as {
    overallRating: number;
    technicalScore: number;
    communicationScore: number;
    behavioralScore: number;
    videoConfidenceScore: number | null;
    hiringRecommendation: string;
    recommendationReason: string;
    summary: string;
    scoresByCategory: Record<string, unknown[]>;
    details: {
      strengths?: Array<{ point: string }>;
      weaknesses?: Array<{ point: string }>;
      skillBreakdown?: Array<{ skill: string; score: number }>;
      communication?: { signals?: Record<string, number> };
      video?: { samples: number; dominantExpression: string } | null;
    };
    sessionCandidate: { insights: unknown[]; transcript: { turns: unknown[] } };
  };

  console.log('');
  console.log('    Overall       ', report.overallRating);
  console.log('    Technical     ', report.technicalScore);
  console.log('    Communication ', report.communicationScore);
  console.log('    Behavioral    ', report.behavioralScore);
  console.log('    Video conf.   ', report.videoConfidenceScore);
  console.log('    Recommendation', report.hiringRecommendation);
  console.log('    Reason        ', report.recommendationReason);
  console.log('    Summary       ', String(report.summary).slice(0, 160));
  console.log('    Strengths     ', report.details.strengths?.length ?? 0);
  console.log('    Weaknesses    ', report.details.weaknesses?.length ?? 0);
  console.log('    Skills scored ', report.details.skillBreakdown?.map((s) => `${s.skill}=${s.score}`).join(', '));
  console.log('    Score rows    ', Object.entries(report.scoresByCategory).map(([k, v]) => `${k}:${v.length}`).join(' '));
  console.log('    Live signals  ', report.sessionCandidate.insights.length);
  console.log('    Transcript    ', report.sessionCandidate.transcript.turns.length, 'turns');
  console.log('    Video samples ', report.details.video?.samples, report.details.video?.dominantExpression);
  console.log('    Speech signals', JSON.stringify(report.details.communication?.signals));

  console.log('');
  console.log('12. Exports');
  for (const [label, path] of [
    ['PDF   ', `/api/reports/${reportId}/export.pdf`],
    ['Excel ', `/api/reports/${reportId}/export.xlsx`],
    ['Session', `/api/sessions/${session.id}/export.xlsx`],
  ] as const) {
    const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    const buf = await res.arrayBuffer();
    console.log(`    ${label} ${res.status} ${(buf.byteLength / 1024).toFixed(1)} KB`);
  }

  console.log('13. Ranking and shortlist');
  const leaderboard = await call(`/api/sessions/${session.id}/leaderboard`) as Array<{ rank: number; name: string; overall: number; recommendation: string }>;
  console.log('   ', JSON.stringify(leaderboard.map((r) => `#${r.rank} ${r.name} ${r.overall} ${r.recommendation}`)));

  const shortlist = await call(`/api/sessions/${session.id}/shortlist`) as { note: string; shortlisted: unknown[] };
  console.log('    shortlist:', shortlist.shortlisted.length, '-', shortlist.note);

  console.log('14. Analytics');
  const analytics = await call('/api/analytics/overview') as { totals: unknown; rates: unknown };
  console.log('    totals', JSON.stringify(analytics.totals));
  console.log('    rates ', JSON.stringify(analytics.rates));

  const skills = await call('/api/analytics/skills') as { skills: Array<{ skill: string; average: number }> };
  console.log('    skills', JSON.stringify(skills.skills.slice(0, 5)));

  console.log('');
  console.log('E2E PASSED');
  process.exit(0);
}

main().catch((err) => {
  console.error(NL + 'E2E FAILED:', err.message);
  process.exit(1);
});
