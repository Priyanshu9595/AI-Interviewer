import Link from 'next/link';
import { ArrowRight, Check, Brain, Sparkles } from 'lucide-react';
import { HeroVisual } from '@/components/marketing/HeroVisual';

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
    <div className="min-h-screen bg-slate-50 text-slate-900 selection:bg-indigo-200">
      {/* Soft Light Gradients Background */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[600px] bg-gradient-to-b from-indigo-100/50 via-white to-transparent" />
      <div className="pointer-events-none absolute right-0 top-[10%] h-[500px] w-[500px] rounded-full bg-purple-200/40 blur-[100px]" />
      <div className="pointer-events-none absolute left-[-10%] top-[30%] h-[600px] w-[600px] rounded-full bg-blue-200/30 blur-[120px]" />

      {/* Floating Stylish Navbar */}
      <div className="fixed inset-x-0 top-4 z-50 flex justify-center px-4 sm:px-6">
        <header className="flex w-full max-w-6xl items-center justify-between rounded-full border border-slate-200/80 bg-white/80 px-4 py-2.5 shadow-lg shadow-indigo-100/50 backdrop-blur-md transition-all hover:border-slate-300 hover:bg-white/90">
          <Link href="/" className="group flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-600 to-purple-600 text-white shadow-md shadow-indigo-600/20 transition-transform group-hover:scale-105 group-hover:shadow-indigo-600/40">
              <Brain className="h-5 w-5" />
            </div>
            <span className="hidden text-sm font-extrabold tracking-tight text-slate-900 sm:block">AI Interview</span>
          </Link>

          <div className="flex items-center gap-3 sm:gap-4">
            <Link
              href="/login"
              className="text-sm font-bold text-slate-600 transition-colors hover:text-indigo-600"
            >
              Sign in
            </Link>
            <Link
              href="/register"
              className="relative inline-flex h-9 items-center justify-center rounded-full bg-indigo-600 px-5 text-sm font-bold text-white transition-all hover:scale-105 hover:bg-indigo-700 hover:shadow-md hover:shadow-indigo-600/30"
            >
              Get started
            </Link>
          </div>
        </header>
      </div>

      {/* Hero */}
      <section className="relative mx-auto max-w-6xl px-4 pb-16 pt-32 sm:px-6 sm:pb-24 sm:pt-40">
        <div className="grid items-center gap-12 lg:grid-cols-[1.1fr_1fr] lg:gap-16">
          <div className="relative z-10">
            <div className="inline-flex items-center gap-2 rounded-full border border-indigo-200/60 bg-indigo-50/80 px-3.5 py-1.5 text-xs font-semibold text-indigo-700 shadow-sm backdrop-blur-sm">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-indigo-500 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-indigo-600" />
              </span>
              Interviews that run themselves
            </div>

            <h1 className="mt-7 text-balance text-5xl font-extrabold leading-[1.1] tracking-tight text-slate-900 sm:text-6xl lg:text-[4rem]">
              Screen every candidate{' '}
              <span className="bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent">
                properly.
              </span>
            </h1>

            <p className="mt-6 max-w-xl text-balance text-lg leading-relaxed text-slate-600 sm:text-xl">
              Describe the role once. The platform schedules the interviews, runs them as a natural spoken
              conversation, and hands you a ranked shortlist with the evidence behind every score.
            </p>

            <div className="mt-10 flex flex-wrap items-center gap-4">
              <Link
                href="/register"
                className="group relative inline-flex h-12 items-center gap-2 rounded-full bg-indigo-600 px-8 text-sm font-medium text-white transition-all hover:-translate-y-0.5 hover:bg-indigo-700 hover:shadow-lg hover:shadow-indigo-600/30"
              >
                Create your first session
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
              </Link>
              <Link
                href="/login"
                className="inline-flex h-12 items-center rounded-full border border-slate-200 bg-white px-8 text-sm font-medium text-slate-700 transition-all hover:-translate-y-0.5 hover:border-slate-300 hover:bg-slate-50 hover:shadow-md"
              >
                Sign in
              </Link>
            </div>

            <ul className="mt-10 flex flex-wrap gap-x-8 gap-y-3">
              {['No scheduling calls', 'Same questions for everyone', 'Evidence for every score'].map((point) => (
                <li key={point} className="flex items-center gap-2 text-sm font-medium text-slate-600">
                  <div className="flex h-5 w-5 items-center justify-center rounded-full bg-indigo-100">
                    <Check className="h-3.5 w-3.5 text-indigo-600" />
                  </div>
                  {point}
                </li>
              ))}
            </ul>
          </div>

          <div className="relative">
            <div className="absolute inset-0 -translate-y-10 scale-110 bg-gradient-to-tr from-indigo-200/40 to-purple-200/40 blur-3xl" />
            <HeroVisual className="relative w-full drop-shadow-xl" />
          </div>
        </div>
      </section>

      {/* Capabilities */}
      <section className="relative border-t border-slate-200 bg-slate-50/50 py-20 sm:py-28">
        <div className="relative mx-auto max-w-6xl px-4 sm:px-6">
          <div className="max-w-2xl">
            <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-indigo-600">
              <Sparkles className="h-4 w-4" />
              What it does
            </p>
            <h2 className="mt-3 text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl">
              Everything a first-round screen needs
            </h2>
            <p className="mt-4 text-lg text-slate-600">
              Not a chatbot with a scorecard bolted on. Every part of the assessment is measured from something real.
            </p>
          </div>

          <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {CAPABILITIES.map((item, i) => (
              <div 
                key={item.title} 
                className="group rounded-2xl border border-slate-200/60 bg-white p-7 shadow-sm transition-all hover:-translate-y-1 hover:shadow-xl hover:shadow-indigo-100"
              >
                <div className="mb-5 flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 font-mono text-sm font-bold text-indigo-600 transition-colors group-hover:bg-indigo-100">
                  {String(i + 1).padStart(2, '0')}
                </div>
                <h3 className="text-base font-bold text-slate-900">{item.title}</h3>
                <p className="mt-2.5 text-sm leading-relaxed text-slate-600">{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="relative bg-white py-20 sm:py-28">
        <div className="pointer-events-none absolute left-1/2 top-1/2 h-[600px] w-[600px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-indigo-50/50 blur-[100px]" />
        
        <div className="relative mx-auto max-w-6xl px-4 sm:px-6">
          <p className="text-xs font-bold uppercase tracking-widest text-indigo-600">How it works</p>
          <h2 className="mt-3 text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl">
            Four steps, then it is autonomous
          </h2>

          <div className="mt-14 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((step) => (
              <div key={step.n} className="relative border-l-2 border-slate-200 pl-5 transition-colors hover:border-indigo-600">
                <span className="font-mono text-sm font-bold tracking-wider text-indigo-600">{step.n}</span>
                <h3 className="mt-2 text-base font-bold text-slate-900">{step.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">{step.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="relative overflow-hidden border-t border-slate-200 bg-white py-20 sm:py-28">
        <div className="absolute inset-0 grain-overlay opacity-[0.02] mix-blend-multiply" />
        <div className="absolute inset-0 bg-gradient-to-b from-transparent to-indigo-50/50" />
        
        <div className="relative mx-auto max-w-2xl px-4 text-center sm:px-6">
          <h2 className="text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl">
            Ready to run your first round?
          </h2>
          <p className="mt-4 text-lg text-slate-600">
            Set up a session in a couple of minutes and send the first invitation today.
          </p>
          <Link
            href="/register"
            className="mt-10 inline-flex h-12 items-center gap-2 rounded-full bg-indigo-600 px-8 text-sm font-bold text-white transition-transform hover:scale-105 hover:bg-indigo-700 hover:shadow-lg hover:shadow-indigo-600/20"
          >
            Get started for free
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-200 bg-slate-50 pb-12 pt-16">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="grid grid-cols-1 gap-12 sm:grid-cols-2 md:grid-cols-4 lg:gap-8">
            <div className="col-span-1 md:col-span-1">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-100 text-indigo-600">
                  <Brain className="h-5 w-5" />
                </div>
                <span className="text-lg font-bold text-slate-900">AI Interview</span>
              </div>
              <p className="mt-4 text-sm leading-relaxed text-slate-500">
                Automating the first round of interviews so you can focus on hiring the best talent.
              </p>
            </div>
            
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Product</h3>
              <ul className="mt-4 space-y-3 text-sm text-slate-500">
                <li><Link href="#" className="transition-colors hover:text-indigo-600">Features</Link></li>
                <li><Link href="#" className="transition-colors hover:text-indigo-600">Use Cases</Link></li>
                <li><Link href="#" className="transition-colors hover:text-indigo-600">Pricing</Link></li>
                <li><Link href="#" className="transition-colors hover:text-indigo-600">Changelog</Link></li>
              </ul>
            </div>

            <div>
              <h3 className="text-sm font-semibold text-slate-900">Company</h3>
              <ul className="mt-4 space-y-3 text-sm text-slate-500">
                <li><Link href="#" className="transition-colors hover:text-indigo-600">About Us</Link></li>
                <li><Link href="#" className="transition-colors hover:text-indigo-600">Careers</Link></li>
                <li><Link href="#" className="transition-colors hover:text-indigo-600">Blog</Link></li>
                <li><Link href="#" className="transition-colors hover:text-indigo-600">Contact</Link></li>
              </ul>
            </div>

            <div>
              <h3 className="text-sm font-semibold text-slate-900">Legal</h3>
              <ul className="mt-4 space-y-3 text-sm text-slate-500">
                <li><Link href="#" className="transition-colors hover:text-indigo-600">Privacy Policy</Link></li>
                <li><Link href="#" className="transition-colors hover:text-indigo-600">Terms of Service</Link></li>
                <li><Link href="#" className="transition-colors hover:text-indigo-600">Security</Link></li>
                <li><Link href="#" className="transition-colors hover:text-indigo-600">Cookie Policy</Link></li>
              </ul>
            </div>
          </div>
          
          <div className="mt-16 flex flex-col items-center justify-between gap-4 border-t border-slate-200 pt-8 sm:flex-row">
            <p className="text-sm text-slate-500">
              &copy; {new Date().getFullYear()} AI Interview Simulator Platform. All rights reserved.
            </p>
            <div className="flex gap-4 text-sm font-medium text-slate-500">
              <Link href="#" className="transition-colors hover:text-slate-900">Twitter</Link>
              <Link href="#" className="transition-colors hover:text-slate-900">LinkedIn</Link>
              <Link href="#" className="transition-colors hover:text-slate-900">GitHub</Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
