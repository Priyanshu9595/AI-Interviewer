/**
 * Seeds a demo recruiter with sessions, candidates and a finished interview
 * so the dashboard has something real to render on a fresh database.
 *
 *   npm run seed
 */
import bcrypt from 'bcryptjs';
import { prisma } from '../src/lib/prisma';
import { QuestionGenerationService } from '../src/services/QuestionGenerationService';

const DEMO_EMAIL = 'recruiter@demo.com';
const DEMO_PASSWORD = 'demo1234';

const daysFromNow = (days: number, hour = 10) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d;
};

async function main() {
  console.log('Seeding…');

  const user = await prisma.user.upsert({
    where: { email: DEMO_EMAIL },
    create: {
      email: DEMO_EMAIL,
      password: await bcrypt.hash(DEMO_PASSWORD, 12),
      name: 'Demo Recruiter',
      company: 'Acme Technologies',
      role: 'RECRUITER',
    },
    update: {},
  });

  // Start clean so re-running the seed does not pile up duplicates.
  await prisma.interviewSession.deleteMany({ where: { userId: user.id } });

  const sessions = [
    {
      title: 'Senior Backend Engineer',
      jobDescription:
        'We are hiring a Senior Backend Engineer to own our payments platform. You will design and ship high-throughput services in Node.js and TypeScript, model data in PostgreSQL, and take responsibility for reliability, observability and on-call. You will work closely with product to break large problems into shippable increments, and mentor two or three engineers.',
      skills: ['Node.js', 'TypeScript', 'PostgreSQL', 'System Design', 'AWS'],
      experienceLevel: 'Senior (5-8 years)',
      type: 'TECHNICAL' as const,
      scheduledAt: daysFromNow(1, 10),
      durationMinutes: 45,
      personality: 'CHALLENGING' as const,
    },
    {
      title: 'Frontend Engineer, Design Systems',
      jobDescription:
        'Join our design systems team to build the component library every product surface depends on. You will write accessible React components in TypeScript, work in close partnership with designers, care deeply about performance and bundle size, and document everything you ship so other teams can move without asking you first.',
      skills: ['React', 'TypeScript', 'CSS', 'Accessibility', 'Testing'],
      experienceLevel: 'Mid-level (3-5 years)',
      type: 'MIXED' as const,
      scheduledAt: daysFromNow(2, 14),
      durationMinutes: 40,
      personality: 'FRIENDLY' as const,
    },
    {
      title: 'Customer Success Manager',
      jobDescription:
        'We are looking for a Customer Success Manager to own relationships with our enterprise accounts. You will run onboarding, drive adoption, spot churn risk before it becomes a renewal problem, and act as the voice of the customer inside product planning. Strong written and verbal communication is essential.',
      skills: ['Account Management', 'Communication', 'Stakeholder Management', 'Data Analysis'],
      experienceLevel: 'Mid-level (3-5 years)',
      type: 'HR' as const,
      scheduledAt: daysFromNow(-2, 11),
      durationMinutes: 30,
      personality: 'NEUTRAL' as const,
    },
  ];

  const candidates = [
    { name: 'Priya Sharma', email: 'priya.sharma@example.com', mobile: '+91 98765 43210' },
    { name: 'Arjun Mehta', email: 'arjun.mehta@example.com', mobile: '+91 91234 56780' },
    { name: 'Sara Khan', email: 'sara.khan@example.com', mobile: '+91 99887 76655' },
    { name: 'Daniel Osei', email: 'daniel.osei@example.com', mobile: '+44 7700 900123' },
    { name: 'Lena Fischer', email: 'lena.fischer@example.com', mobile: '+49 151 23456789' },
  ];

  for (const c of candidates) {
    await prisma.candidate.upsert({
      where: { email: c.email },
      create: c,
      update: { name: c.name, mobile: c.mobile },
    });
  }
  const stored = await prisma.candidate.findMany({ where: { email: { in: candidates.map((c) => c.email) } } });

  for (const [i, s] of sessions.entries()) {
    const session = await prisma.interviewSession.create({
      data: {
        ...s,
        userId: user.id,
        status: s.scheduledAt < new Date() ? 'COMPLETED' : 'SCHEDULED',
        meetingProvider: 'GOOGLE_MEET',
        // Sample data only. The bot is never pointed at these; a real interview
        // carries a link the recruiter pasted or a provider created.
        meetingLink: `https://meet.google.com/sample-demo-${i + 1}`,
        language: 'en-US',
        codingEnabled: s.type !== 'HR',
      },
    });

    // Spread candidates across sessions so each has a couple.
    const assigned = stored.slice(i, i + 3).length ? stored.slice(i, i + 3) : stored.slice(0, 2);

    for (const candidate of assigned) {
      await prisma.sessionCandidate.create({
        data: {
          interviewSessionId: session.id,
          candidateId: candidate.id,
          status: session.status === 'COMPLETED' ? 'ABSENT' : 'INVITED',
          invitedAt: new Date(),
          ...(session.status === 'COMPLETED' ? { absentAt: new Date() } : {}),
        },
      });
    }

    // Question generation needs the LLM; skip gracefully if it is unavailable.
    try {
      await QuestionGenerationService.generateAndSave(session.id);
      const count = await prisma.question.count({ where: { questionSet: { interviewSessionId: session.id } } });
      console.log(`  ${session.title}: ${count} questions generated`);
    } catch (err) {
      console.warn(`  ${session.title}: question generation skipped (${(err as Error).message})`);
    }
  }

  console.log('\nDone.');
  console.log(`  Email:    ${DEMO_EMAIL}`);
  console.log(`  Password: ${DEMO_PASSWORD}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
