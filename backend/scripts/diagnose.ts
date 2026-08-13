import { prisma } from '../src/lib/prisma';

(async () => {
  const rows = await prisma.sessionCandidate.findMany({
    where: { joinedAt: { not: null } },
    orderBy: { joinedAt: 'desc' },
    take: 6,
    include: {
      candidate: { select: { name: true, email: true } },
      interviewSession: {
        select: { title: true, videoAnalysisEnabled: true, durationMinutes: true },
      },
      report: { select: { id: true } },
      transcript: { include: { _count: { select: { turns: true } } } },
      _count: { select: { submissions: true, videoFrames: true, insights: true } },
    },
  });

  for (const r of rows) {
    console.log(`\n${'='.repeat(72)}`);
    console.log(`${r.candidate.name} <${r.candidate.email}>`);
    console.log(`  session         : ${r.interviewSession.title}`);
    console.log(`  status          : ${r.status}`);
    console.log(`  joined / done   : ${r.joinedAt?.toLocaleString()} / ${r.completedAt?.toLocaleString() ?? 'never'}`);
    console.log(`  videoAnalysis   : ${r.interviewSession.videoAnalysisEnabled}`);
    console.log(`  --- what was captured ---`);
    console.log(`  transcript turns: ${r.transcript?._count.turns ?? 0}`);
    console.log(`  video frames    : ${r._count.videoFrames}`);
    console.log(`  coding subs     : ${r._count.submissions}`);
    console.log(`  live insights   : ${r._count.insights}`);
    console.log(`  report          : ${r.report?.id ?? 'NONE'}`);
    if (r.evaluationError) console.log(`  eval error      : ${r.evaluationError.slice(0, 110)}`);
  }

  process.exit(0);
})();
