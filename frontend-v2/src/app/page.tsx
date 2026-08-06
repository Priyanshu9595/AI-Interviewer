import Link from 'next/link';
import {
  ArrowRight,
  BarChart3,
  Bot,
  Code2,
  FileText,
  Gauge,
  Mic,
  ScanFace,
  Sparkles,
  Users,
  ChevronRight
} from 'lucide-react';
import { cn } from '@/lib/utils';

const FEATURES = [
  {
    icon: Sparkles,
    title: 'Questions from JD',
    body: 'Paste a job description and the platform builds behavioral, technical, scenario, and coding questions calibrated to the requested experience level.',
    color: 'from-blue-500 to-cyan-400'
  },
  {
    icon: Mic,
    title: 'Real Spoken Dialogue',
    body: 'The AI interviewer speaks, listens, and asks its own follow-ups when an answer is thin. It never reveals scores or teaches the answer.',
    color: 'from-indigo-500 to-purple-500'
  },
  {
    icon: Gauge,
    title: 'Measured Communication',
    body: 'Fluency, confidence, clarity, grammar, and pace are calculated from actual speech measurements like pause length and speaking rate.',
    color: 'from-emerald-400 to-teal-500'
  },
  {
    icon: Code2,
    title: 'Live Code Execution',
    body: 'Coding answers execute against real test cases in a secure sandbox, then get reviewed automatically for complexity and correctness.',
    color: 'from-orange-400 to-red-500'
  },
  {
    icon: ScanFace,
    title: 'On-camera Presence',
    body: 'The browser samples video locally and sends only aggregate numbers like face steadiness and expression. No imagery leaves the machine.',
    color: 'from-pink-500 to-rose-400'
  },
  {
    icon: FileText,
    title: 'Actionable Reports',
    body: 'Every strength and weakness cites a specific moment from the transcript. Export to PDF, Excel, or push straight into your ATS.',
    color: 'from-sky-400 to-blue-600'
  },
];

const STEPS = [
  { n: '01', title: 'Create the session', body: 'Set the job description, skills, experience level, and round type in seconds.' },
  { n: '02', title: 'Add candidates', body: 'Upload a CSV or add individually. Invites and reminders go out automatically.' },
  { n: '03', title: 'The AI runs the round', body: 'It verifies identity, handles doubts, and works through every round naturally.' },
  { n: '04', title: 'Review and decide', body: 'Get scored reports, a ranked shortlist, and a clear hiring recommendation.' },
];

export default function LandingPage() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-slate-50 text-slate-900 selection:bg-indigo-500/30">
      
      {/* Background Decor */}
      <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] rounded-full bg-indigo-400/20 blur-[120px] mix-blend-multiply pointer-events-none" />
      <div className="absolute top-[20%] right-[-10%] w-[40%] h-[50%] rounded-full bg-cyan-400/20 blur-[120px] mix-blend-multiply pointer-events-none" />
      <div className="absolute bottom-[-10%] left-[20%] w-[60%] h-[40%] rounded-full bg-purple-400/20 blur-[120px] mix-blend-multiply pointer-events-none" />

      {/* Nav */}
      <header className="sticky top-0 z-50 border-b border-white/20 bg-white/60 backdrop-blur-xl shadow-sm">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-600 to-blue-500 text-sm font-bold text-white shadow-md">
              A
            </div>
            <span className="text-lg font-bold tracking-tight text-slate-800">AI Interview</span>
          </div>
          <div className="flex items-center gap-4">
            <Link
              href="/login"
              className="text-sm font-semibold text-slate-600 transition-colors hover:text-indigo-600"
            >
              Sign in
            </Link>
            <Link
              href="/register"
              className="rounded-full bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white shadow-lg transition-all hover:scale-105 hover:bg-indigo-600"
            >
              Get started
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative mx-auto max-w-7xl px-6 pb-20 pt-24 sm:pt-32 lg:pb-32">
        <div className="mx-auto max-w-4xl text-center">
          <div className="inline-flex animate-fade-in-up items-center gap-2 rounded-full border border-indigo-500/20 bg-indigo-50/50 px-4 py-1.5 text-sm font-semibold text-indigo-700 backdrop-blur-md">
            <Sparkles className="h-4 w-4 text-indigo-500" />
            <span>The future of automated screening</span>
          </div>

          <h1 className="mt-8 text-balance text-5xl font-extrabold leading-[1.1] tracking-tight sm:text-7xl">
            Screen every candidate properly,{' '}
            <span className="bg-gradient-to-r from-indigo-600 via-purple-600 to-cyan-500 bg-clip-text text-transparent">
              without booking a single hour.
            </span>
          </h1>

          <p className="mx-auto mt-8 max-w-2xl text-balance text-lg leading-relaxed text-slate-600 sm:text-xl">
            Describe the role once. The platform schedules the interviews, runs them as a natural spoken conversation,
            evaluates technical depth, communication and behaviour, and hands you a ranked shortlist.
          </p>

          <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
            <Link
              href="/register"
              className="inline-flex h-14 items-center gap-2 rounded-full bg-gradient-to-r from-indigo-600 to-blue-500 px-8 text-base font-semibold text-white shadow-xl shadow-indigo-500/25 transition-all hover:scale-105 hover:shadow-indigo-500/40"
            >
              Start screening for free
              <ArrowRight className="h-5 w-5" />
            </Link>
            <Link
              href="/login"
              className="inline-flex h-14 items-center gap-2 rounded-full border border-slate-200 bg-white/80 px-8 text-base font-semibold text-slate-700 shadow-sm backdrop-blur-md transition-all hover:bg-slate-50"
            >
              Sign in to dashboard
            </Link>
          </div>
        </div>

        {/* Mock interview panel (Glassmorphism) */}
        <div className="mx-auto mt-20 max-w-4xl">
          <div className="relative rounded-2xl border border-white bg-white/40 p-2 shadow-2xl backdrop-blur-2xl transition-transform hover:-translate-y-2 duration-500">
            <div className="absolute inset-0 rounded-2xl bg-gradient-to-tr from-white/60 to-white/10" />
            <div className="relative rounded-xl border border-slate-100 bg-white/80 shadow-inner">
              <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4 bg-slate-50/50 rounded-t-xl">
                <div className="flex items-center gap-3">
                  <span className="relative flex h-3 w-3">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-70" />
                    <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-500" />
                  </span>
                  <span className="text-sm font-semibold text-slate-700">Interview in progress &middot; Technical Round</span>
                </div>
                <span className="font-mono text-sm font-medium text-slate-500">18:24</span>
              </div>

              <div className="space-y-6 p-6 text-left">
                <div className="flex gap-4">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-blue-500 shadow-md">
                    <Bot className="h-5 w-5 text-white" />
                  </div>
                  <div className="relative max-w-[85%] rounded-2xl rounded-tl-sm bg-slate-100 px-5 py-3.5 text-[15px] leading-relaxed text-slate-800">
                    You mentioned you optimised the checkout service. What was the actual bottleneck, and how did you confirm it?
                  </div>
                </div>

                <div className="flex justify-end gap-4">
                  <div className="relative max-w-[85%] rounded-2xl rounded-tr-sm bg-indigo-600 px-5 py-3.5 text-[15px] leading-relaxed text-white shadow-md">
                    We were doing an N+1 on the line items. I found it in the APM traces — 400 queries per request.
                  </div>
                </div>

                <div className="flex flex-wrap gap-3 border-t border-slate-100 pt-5">
                  <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
                    Strong answer &middot; Specific evidence
                  </span>
                  <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-600">
                    Responded in 0.9s
                  </span>
                  <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-600">
                    142 wpm
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="relative z-10 border-t border-slate-200 bg-white py-24 sm:py-32">
        <div className="mx-auto max-w-7xl px-6">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl">
              Everything a first-round screen needs
            </h2>
            <p className="mt-4 text-lg text-slate-600">
              Not just a chatbot with a scorecard bolted on. Each part of the assessment is measured from actual live interaction.
            </p>
          </div>

          <div className="mx-auto mt-16 grid max-w-5xl gap-8 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, body, color }) => (
              <div 
                key={title} 
                className="group relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-8 transition-all hover:-translate-y-1 hover:shadow-xl hover:shadow-slate-200/50"
              >
                <div className={cn("absolute inset-0 opacity-0 transition-opacity duration-500 group-hover:opacity-5 bg-gradient-to-br", color)} />
                <div className={cn("flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br shadow-sm mb-6 text-white", color)}>
                  <Icon className="h-6 w-6" />
                </div>
                <h3 className="text-xl font-bold text-slate-900">{title}</h3>
                <p className="mt-3 text-sm leading-relaxed text-slate-600">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="relative z-10 overflow-hidden bg-slate-900 py-24 sm:py-32 text-white">
        {/* Dark theme decor */}
        <div className="absolute top-0 right-0 -translate-y-12 translate-x-1/3">
          <div className="h-[400px] w-[400px] rounded-full bg-indigo-500/20 blur-[100px]" />
        </div>
        
        <div className="relative mx-auto max-w-7xl px-6">
          <div className="max-w-2xl">
            <h2 className="text-3xl font-extrabold tracking-tight sm:text-4xl">How it works</h2>
            <p className="mt-4 text-lg text-slate-400">
              A frictionless process from job description to final hiring decision.
            </p>
          </div>

          <div className="mt-16 grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((step, i) => (
              <div key={step.n} className="relative">
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-indigo-500/20 border border-indigo-500/30 text-sm font-bold text-indigo-300">
                  {step.n}
                </div>
                <h3 className="text-lg font-bold text-white">{step.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-400">{step.body}</p>
                {i !== STEPS.length - 1 && (
                  <ChevronRight className="absolute -right-5 top-12 hidden h-6 w-6 text-slate-700 lg:block" />
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="relative z-10 overflow-hidden bg-indigo-600 py-24 text-center">
        <div className="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/cubes.png')] opacity-10" />
        <div className="relative mx-auto max-w-3xl px-6">
          <Users className="mx-auto h-12 w-12 text-indigo-200" />
          <h2 className="mt-6 text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
            Ready to run your first round?
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-lg text-indigo-100">
            Set up a session in a couple of minutes and send the first invite today. Experience the power of AI-driven recruitment.
          </p>
          <Link
            href="/register"
            className="mt-8 inline-flex h-14 items-center gap-2 rounded-full bg-white px-8 text-base font-bold text-indigo-600 shadow-xl transition-all hover:scale-105 hover:bg-slate-50"
          >
            Create your account
            <ArrowRight className="h-5 w-5" />
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-200 bg-white py-12">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-6 px-6 sm:flex-row text-sm font-medium text-slate-500">
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded bg-indigo-600 text-xs font-bold text-white">
              A
            </div>
            <span className="text-slate-900">AI Interview Platform</span>
          </div>
          <span className="flex items-center gap-1.5">
            <BarChart3 className="h-4 w-4" />
            Built for automated first-round screening
          </span>
        </div>
      </footer>
    </div>
  );
}
