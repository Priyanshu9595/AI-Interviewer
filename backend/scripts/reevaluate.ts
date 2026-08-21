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
 *   npm run reevaluate -- --stale        list every report predating the rule
 *   npm run reevaluate -- --stale --write re-run all of them, oldest first
 */
import { prisma } from '../src/lib/prisma';
import { EvaluationService } from '../src/services/EvaluationService';
import { reportHalves } from '../src/lib/reportScores';

const args = process.argv.slice(2);
const stale = args.includes('--stale');
const write = args.includes('--write');
const target = args.find((a) => !a.startsWith('--'));

if (!target && !stale) {
  console.error('Usage: npm run reevaluate -- <email or sessionCandidateId>');
  console.error('       npm run reevaluate -- --stale [--write]');
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
  // A report scored before the rule has no halves at all — that is the point
  // of running this on it.
  const halves = reportHalves(r);
  const soft = halves ? halves.soft.toFixed(1).padStart(4) : '   —';
  const hard = halves ? halves.hard.toFixed(1).padStart(4) : '   —';

  console.log(
    `  ${label.padEnd(7)} overall ${r.overallRating.toFixed(1).padStart(4)}` +
      `   soft ${soft}   hard ${hard}` +
      `   |  comm ${r.communicationScore.toFixed(1)}  behav ${r.behavioralScore.toFixed(1)}` +
      `  tech ${r.technicalScore.toFixed(1)}  coding ${r.codingScore?.toFixed(1) ?? '—'}` +
      `   ${r.hiringRecommendation}`,
  );
}

/**
 * Every report written before the rule stored its halves.
 *
 * Their overall came from the old weighting, so it is not the mean of the two
 * halves the list now shows beside it, and the row reads as broken until the
 * evaluation is run again.
 */
async function runStale() {
  const rows = await prisma.report.findMany({
    orderBy: { createdAt: 'asc' },
    select: {
      sessionCandidateId: true,
      overallRating: true,
      createdAt: true,
      details: true,
      sessionCandidate: {
        select: { candidate: { select: { name: true, email: true } }, interviewSession: { select: { title: true } } },
      },
    },
  });

  const pending = rows.filter((r) => !(r.details as { halves?: unknown } | null)?.halves);

  console.log(`${rows.length} report(s), ${pending.length} predating the current rule`);
  console.log('');
  for (const r of pending) {
    console.log(
      `  ${r.createdAt.toISOString().slice(0, 10)}  ${String(r.overallRating.toFixed(1)).padStart(4)}` +
        `  ${r.sessionCandidate.candidate.name} — ${r.sessionCandidate.interviewSession.title}`,
    );
  }

  if (!pending.length) return;

  if (!write) {
    console.log('');
    console.log('Nothing was changed. Add --write to re-run these, which replaces each report.');
    return;
  }

  console.log('');
  let done = 0;
  let failed = 0;

  for (const r of pending) {
    const who = r.sessionCandidate.candidate.name;
    try {
      await EvaluationService.evaluate(r.sessionCandidateId);
      const after = await prisma.report.findUnique({
        where: { sessionCandidateId: r.sessionCandidateId },
        select: { overallRating: true },
      });
      const from = r.overallRating.toFixed(1);
      const to = after?.overallRating.toFixed(1) ?? '?';
      console.log(`  ok    ${who.padEnd(20)} ${from} -> ${to}`);
      done++;
    } catch (err) {
      // One bad transcript should not stop the rest of the backlog.
      console.log(`  fail  ${who.padEnd(20)} ${(err as Error).message.slice(0, 90)}`);
      failed++;
    }
  }

  console.log('');
  console.log(`${done} re-scored, ${failed} failed`);
}

async function main() {
  if (stale) return runStale();

  const sc = await prisma.sessionCandidate.findFirst({
    where: target!.includes('@') ? { candidate: { email: target! } } : { id: target! },
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
