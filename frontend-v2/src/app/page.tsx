import Link from 'next/link';
import { ArrowRight, Check } from 'lucide-react';
import { HeroVisual } from '@/components/marketing/HeroVisual';

/**
 * The landing page is deliberately monochromatic: one hue (the brand indigo)
 * carried through every surface, with weight and opacity doing the work that a
 * second colour would otherwise do. Restraint reads as professional; a second
 * accent would make it look like a template.
 */

const CAPABILITIES = [
  {
    title: 'Questions written from your job description',
    body: 'Paste the role once. Intro, behavioural, technical, scenario, project and coding questions are written to match the seniority you asked for — not pulled from a generic bank.',
  },
  {
    title: 'A real spoken conversation',
    body: 'The interviewer speaks and listens. When an answer is vague it asks its own follow-up, and it answers a candidate’s clarifying question without giving anything away.',
  },
  {
    title: 'Communication measured, not guessed',
    body: 'Fluency, confidence, clarity, grammar, vocabulary and pace come from the speech itself — pause length before answering, filler density, speaking rate.',
  },
  {
    title: 'Code that actually runs',
    body: 'Coding answers execute against real test cases, including hidden ones, then get judged on correctness, complexity and quality.',
  },
  {
    title: 'Evidence behind every score',
    body: 'Each strength and weakness cites a specific moment from the transcript. Export to PDF or Excel, or push straight into your ATS.',
  },
  {
    title: 'Runs without you',
    body: 'Invitations, reminders at 24 hours, 1 hour and 5 minutes, no-show handling and scoring all happen on their own.',
  },
];

const STEPS = [
  { n: '01', title: 'Describe the role', body: 'Job description, required skills, seniority, round type and duration.' },
  { n: '02', title: 'Add candidates', body: 'One at a time, or a CSV upload. Everyone gets their own link and reminders.' },
  { n: '03', title: 'The AI runs the round', body: 'It verifies identity, works through every round, and handles questions.' },
  { n: '04', title: 'Review the shortlist', body: 'Scored reports ranked by hiring recommendation, with the evidence attached.' },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3.5 sm:px-6">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-sm font-bold text-primary-foreground">
              A
            </div>
            <span className="text-sm font-semibold tracking-tight">AI Interview</span>
          </div>

          <div className="flex items-center gap-1 sm:gap-2">
            <Link
              href="/login"
              className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Sign in
            </Link>
            <Link
              href="/register"
              className="rounded-md bg-primary px-3.5 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover"
            >
              Get started
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="mx-auto max-w-6xl px-4 pb-14 pt-14 sm:px-6 sm:pb-20 sm:pt-20">
        <div className="grid items-center gap-10 lg:grid-cols-[1.05fr_1fr] lg:gap-14">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary-soft px-3 py-1 text-xs font-medium text-primary">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
              </span>
              Interviews that run themselves
            </span>

            <h1 className="mt-5 text-balance text-4xl font-semibold leading-[1.08] tracking-tight text-foreground sm:text-5xl">
              Screen every candidate properly, without booking a single hour
            </h1>

            <p className="mt-5 max-w-xl text-balance text-base leading-relaxed text-muted-foreground sm:text-lg">
              Describe the role once. The platform schedules the interviews, runs them as a natural spoken
              conversation, and hands you a ranked shortlist with the evidence behind every score.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                href="/register"
                className="inline-flex h-11 items-center gap-2 rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground shadow-card transition-colors hover:bg-primary-hover"
              >
                Create your first session
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/login"
                className="inline-flex h-11 items-center rounded-md border border-border bg-surface px-6 text-sm font-medium text-foreground transition-colors hover:bg-muted"
              >
                Sign in
              </Link>
            </div>

            <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2">
              {['No scheduling calls', 'Same questions for everyone', 'Evidence for every score'].map((point) => (
                <li key={point} className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Check className="h-3.5 w-3.5 text-primary" />
                  {point}
                </li>
              ))}
            </ul>
          </div>

          <HeroVisual className="w-full" />
        </div>
      </section>

      {/* Capabilities */}
      <section className="border-t border-border bg-surface py-16 sm:py-20">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="max-w-2xl">
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-primary">What it does</p>
            <h2 className="mt-2.5 text-2xl font-semibold tracking-tight sm:text-3xl">
              Everything a first-round screen needs
            </h2>
            <p className="mt-3 text-muted-foreground">
              Not a chatbot with a scorecard bolted on. Every part of the assessment is measured from something real.
            </p>
          </div>

          <div className="mt-12 grid gap-x-10 gap-y-9 sm:grid-cols-2 lg:grid-cols-3">
            {CAPABILITIES.map((item, i) => (
              <div key={item.title} className="border-t border-border pt-5">
                <span className="font-mono text-xs text-primary">{String(i + 1).padStart(2, '0')}</span>
                <h3 className="mt-2 text-sm font-semibold text-foreground">{item.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="py-16 sm:py-20">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-primary">How it works</p>
          <h2 className="mt-2.5 text-2xl font-semibold tracking-tight sm:text-3xl">Four steps, then it is autonomous</h2>

          <div className="mt-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((step) => (
              <div key={step.n} className="border-l-2 border-primary/25 pl-4">
                <span className="font-mono text-xs font-semibold text-primary">{step.n}</span>
                <h3 className="mt-1.5 text-sm font-semibold text-foreground">{step.title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{step.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-border bg-primary py-16 sm:py-20">
        <div className="mx-auto max-w-2xl px-4 text-center sm:px-6">
          <h2 className="text-2xl font-semibold tracking-tight text-primary-foreground sm:text-3xl">
            Ready to run your first round?
          </h2>
          <p className="mt-3 text-primary-foreground/80">
            Set up a session in a couple of minutes and send the first invitation today.
          </p>
          <Link
            href="/register"
            className="mt-8 inline-flex h-11 items-center gap-2 rounded-md bg-surface px-6 text-sm font-medium text-primary shadow-card transition-opacity hover:opacity-90"
          >
            Get started
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      <footer className="border-t border-border py-7">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 text-sm text-muted-foreground sm:px-6">
          <span>AI Interview Simulator Platform</span>
          <span>Automated first-round screening</span>
        </div>
      </footer>
    </div>
  );
}
