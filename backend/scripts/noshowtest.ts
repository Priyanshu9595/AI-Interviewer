/**
 * Exercises the no-show path against real database rows:
 *   wait -> reminder notification -> mark absent
 *
 * Two sessions are backdated so both stages fire inside one scheduler tick.
 */
import { prisma } from '../src/lib/prisma';
import { SchedulerService } from '../src/services/SchedulerService';
import { env } from '../src/lib/env';

const grace = env.NO_SHOW_GRACE_MINUTES;
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

async function makeCandidate(label: string, scheduledAt: Date) {
  const user = await prisma.user.findFirst();
  if (!user) throw new Error('Seed the database first (npm run seed)');

  const session = await prisma.interviewSession.create({
    data: {
      userId: user.id,
      title: `No-show test — ${label}`,
      jobDescription: 'A backdated session used to exercise the no-show path end to end.',
      skills: ['Testing'],
      experienceLevel: 'Mid-level (3-5 years)',
      type: 'HR',
      scheduledAt,
      durationMinutes: 30,
      status: 'ACTIVE',
      codingEnabled: false,
    },
  });

  const email = `noshow-${label}-${Date.now()}@example.com`;
  const candidate = await prisma.candidate.create({ data: { name: `No Show ${label}`, email } });

  const sc = await prisma.sessionCandidate.create({
    data: {
      interviewSessionId: session.id,
      candidateId: candidate.id,
      status: 'INVITED',
      invitedAt: new Date(),
    },
  });

  // Invites are irrelevant here and would burn real email credits.
  await prisma.reminder.updateMany({ where: { sessionCandidateId: sc.id }, data: { status: 'SKIPPED' } });

  return { sessionId: session.id, sc };
}

async function state(id: string) {
  const sc = await prisma.sessionCandidate.findUnique({
    where: { id },
    include: { reminders: { where: { kind: 'NO_SHOW_NUDGE' } } },
  });
  return {
    status: sc?.status,
    absentAt: sc?.absentAt,
    nudge: sc?.reminders[0]?.status ?? 'none',
  };
}

(async () => {
  console.log(`Grace period: ${grace} minutes\n`);

  // Halfway through the grace window: should be nudged, not yet absent.
  const nudgeCase = await makeCandidate('nudge', minutesAgo(grace * 0.6));
  // Past the grace window: should be marked absent.
  const absentCase = await makeCandidate('absent', minutesAgo(grace * 1.5));
  // Not started yet: should be left completely alone.
  const futureCase = await makeCandidate('future', new Date(Date.now() + 30 * 60_000));

  console.log('before tick');
  console.log('  late-but-in-window :', JSON.stringify(await state(nudgeCase.sc.id)));
  console.log('  past-grace         :', JSON.stringify(await state(absentCase.sc.id)));
  console.log('  not-started        :', JSON.stringify(await state(futureCase.sc.id)));

  console.log('\nrunning scheduler tick...');
  await SchedulerService.tick();

  const after = {
    nudge: await state(nudgeCase.sc.id),
    absent: await state(absentCase.sc.id),
    future: await state(futureCase.sc.id),
  };

  console.log('\nafter tick');
  console.log('  late-but-in-window :', JSON.stringify(after.nudge));
  console.log('  past-grace         :', JSON.stringify(after.absent));
  console.log('  not-started        :', JSON.stringify(after.future));

  // A second tick must not re-nudge or double-process anyone.
  console.log('\nrunning a second tick (idempotency)...');
  await SchedulerService.tick();
  const twice = await state(nudgeCase.sc.id);
  console.log('  late-but-in-window :', JSON.stringify(twice));

  console.log('\n=== assertions ===');
  const checks: Array<[string, boolean]> = [
    ['late candidate was nudged', after.nudge.nudge === 'SENT' || after.nudge.nudge === 'FAILED'],
    ['late candidate is NOT yet absent', after.nudge.status === 'INVITED'],
    ['past-grace candidate marked ABSENT', after.absent.status === 'ABSENT'],
    ['past-grace candidate has an absentAt timestamp', Boolean(after.absent.absentAt)],
    ['not-started candidate untouched', after.future.status === 'INVITED' && after.future.nudge === 'none'],
    ['nudge is not repeated on a second tick', twice.nudge === after.nudge.nudge],
  ];

  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) failed++;
  }

  // Clean up the throwaway sessions.
  await prisma.interviewSession.deleteMany({
    where: { id: { in: [nudgeCase.sessionId, absentCase.sessionId, futureCase.sessionId] } },
  });
  console.log('\ncleaned up test sessions');

  console.log(failed === 0 ? '\nNO-SHOW FLOW OK' : `\n${failed} CHECK(S) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('NO-SHOW TEST FAILED:', err);
  process.exit(1);
});
