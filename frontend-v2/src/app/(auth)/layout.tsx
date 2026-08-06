import Link from 'next/link';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      {/* Left side */}
      <div className="hidden lg:flex w-[45%] flex-col justify-between bg-sky-500 p-12 text-white">
        <div>
          <Link href="/" className="flex items-center gap-2 text-white">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-white text-base font-bold text-sky-600">
              A
            </div>
            <span className="text-xl font-bold tracking-tight">AI Interview</span>
          </Link>
        </div>
        
        <div className="max-w-md">
          <h1 className="text-5xl font-black uppercase tracking-tight leading-[1.1]">
            Unified<br />Workspace.
          </h1>
          <p className="mt-6 text-lg font-medium leading-relaxed text-white/90">
            One intelligent portal for everyone. Automatically schedule, run, and evaluate interviews with AI.
          </p>
        </div>

        <div className="text-sm font-medium text-white/80">
          &copy; {new Date().getFullYear()} AI Interview Platform
        </div>
      </div>

      {/* Right side */}
      <div className="flex w-full lg:w-[55%] flex-col bg-surface relative">
        <div className="absolute right-8 top-8 hidden sm:block">
          <Link href="/" className="flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
            &larr; Back to home
          </Link>
        </div>
        
        <div className="flex flex-1 items-center justify-center p-6 sm:p-12">
          <div className="w-full max-w-[400px]">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
