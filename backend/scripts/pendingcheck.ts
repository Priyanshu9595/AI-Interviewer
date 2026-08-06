import { prisma } from '../src/lib/prisma';

(async () => {
  const pending = await prisma.sessionCandidate.findMany({
    where: { status: 'COMPLETED', report: null, transcript: { isNot: null } },
    select: {
      id: true,
      completedAt: true,
      evaluationAttempts: true,
      evaluationError: true,
      evaluationRetryAt: true,
      candidate: { select: { name: true } },
      interviewSession: { select: { title: true } },
    },
    orderBy: { completedAt: 'desc' },
  });

  console.log(`${pending.length} completed interview(s) awaiting a report:`);
  for (const p of pending) {
    console.log(`  ${p.candidate.name} — ${p.interviewSession.title.slice(0, 34)}`);
    console.log(`     attempts=${p.evaluationAttempts} retryAt=${p.evaluationRetryAt?.toLocaleTimeString() ?? '-'}`);
    if (p.evaluationError) console.log(`     last error: ${p.evaluationError.slice(0, 130)}`);
  }
  process.exit(0);
})();
