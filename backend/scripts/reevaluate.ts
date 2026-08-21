/**
 * Re-scores a finished interview against the current scoring rule.
 *
 * A report keeps whatever numbers it was written with, so changing how scoring
 * works leaves every existing report stale. This re-runs the evaluation for one
 * candidate and prints the before and after side by side.
 *
 * The judge runs again, so the sub-scores can move a little on their own — the
 * transcript is fixed but the model is not deterministic. The old report is
 * replaced, not kept.
 *
 *   npm run reevaluate -- <email or sessionCandidateId>
 */
import { prisma } from '../src/lib/prisma';
import { EvaluationService } from '../src/services/EvaluationService';
import { reportHalves } from '../src/lib/reportScores';

const target = process.argv[2];

if (!target) {
  console.error('Usage: npm run reevaluate -- <email or sessionCandidateId>');
  process.exit(1);
}

type Snapshot = {
  overallRating: number;
  technicalScore: number;
  communicationScore: number;
  behavioralScore: number;
  codingScore: number | null;
  hiringRecommendation: string;
  details: unknown;
};

function show(label: string, r: Snapshot | null) {
  if (!r) {
    console.log(`  ${label.padEnd(7)} (none)`);
    return;
  }
  const { soft, hard } = reportHalves(r);
  console.log(
    `  ${label.padEnd(7)} overall ${r.overallRating.toFixed(1).padStart(4)}` +
      `   soft ${soft.toFixed(1).padStart(4)}   hard ${hard.toFixed(1).padStart(4)}` +
      `   |  comm ${r.communicationScore.toFixed(1)}  behav ${r.behavioralScore.toFixed(1)}` +
      `  tech ${r.technicalScore.toFixed(1)}  coding ${r.codingScore?.toFixed(1) ?? '—'}` +
      `   ${r.hiringRecommendation}`,
  );
}

async function main() {
  const sc = await prisma.sessionCandidate.findFirst({
    where: target.includes('@') ? { candidate: { email: target } } : { id: target },
    orderBy: { createdAt: 'desc' },
    include: { candidate: true, report: true, interviewSession: { select: { title: true, passMark: true } } },
  });

  if (!sc) {
    console.error(`No interview found for "${target}".`);
    process.exit(1);
  }

  console.log(`${sc.candidate.name} <${sc.candidate.email}>`);
  console.log(`${sc.interviewSession.title} · pass mark ${sc.interviewSession.passMark}/10`);
  console.log('');

  const before = sc.report as Snapshot | null;
  show('before', before);

  console.log('');
  console.log('  re-running the evaluation, the judge included...');
  await EvaluationService.evaluate(sc.id);

  const after = (await prisma.report.findUnique({ where: { sessionCandidateId: sc.id } })) as Snapshot | null;
  console.log('');
  show('after', after);

  if (before && after) {
    const delta = after.overallRating - before.overallRating;
    console.log('');
    console.log(`  overall moved ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`);
    if (before.hiringRecommendation !== after.hiringRecommendation) {
      console.log(`  recommendation changed: ${before.hiringRecommendation} -> ${after.hiringRecommendation}`);
    }
  }
}

main()
  .catch((err) => {
    console.error(`\nFailed: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
