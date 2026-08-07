'use client';

import React from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-foreground hover:bg-primary-hover shadow-card',
  secondary: 'bg-muted text-foreground hover:bg-border',
  outline: 'border border-border bg-surface text-foreground hover:bg-muted',
  ghost: 'text-muted-foreground hover:bg-muted hover:text-foreground',
  danger: 'bg-danger text-white hover:brightness-95',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-sm gap-1.5',
  md: 'h-9 px-4 text-sm gap-2',
  lg: 'h-11 px-6 text-base gap-2',
  icon: 'h-9 w-9',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', loading, disabled, children, ...props }, ref) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-md font-medium transition-colors',
        'disabled:pointer-events-none disabled:opacity-50',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      {...props}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  ),
);
Button.displayName = 'Button';

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export const Card = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('card', className)} {...props} />
);

export const CardHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4', className)} {...props} />
);

export const CardTitle = ({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
  <h3 className={cn('text-sm font-semibold tracking-tight text-foreground', className)} {...props} />
);

export const CardDescription = ({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
  <p className={cn('mt-0.5 text-sm text-muted-foreground', className)} {...props} />
);

export const CardBody = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('p-5', className)} {...props} />
);

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'h-9 w-full rounded-md border border-input bg-surface px-3 text-sm text-foreground transition-colors',
        'placeholder:text-muted-foreground/70 focus-visible:border-primary disabled:cursor-not-allowed disabled:bg-muted',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'w-full rounded-md border border-input bg-surface px-3 py-2 text-sm leading-relaxed text-foreground transition-colors',
        'placeholder:text-muted-foreground/70 focus-visible:border-primary disabled:cursor-not-allowed disabled:bg-muted',
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = 'Textarea';

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        'h-9 w-full appearance-none rounded-md border border-input bg-surface bg-no-repeat px-3 pr-8 text-sm text-foreground transition-colors',
        'focus-visible:border-primary disabled:cursor-not-allowed disabled:bg-muted',
        className,
      )}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='%2364748b'%3E%3Cpath fill-rule='evenodd' d='M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z' clip-rule='evenodd'/%3E%3C/svg%3E\")",
        backgroundPosition: 'right 0.5rem center',
        backgroundSize: '1.15rem',
      }}
      {...props}
    >
      {children}
    </select>
  ),
);
Select.displayName = 'Select';

export function Field({
  label,
  hint,
  error,
  required,
  children,
  className,
}: {
  label?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      {label && (
        <label className="label">
          {label}
          {required && <span className="ml-0.5 text-primary">*</span>}
        </label>
      )}
      {children}
      {error ? <p className="text-xs text-danger">{error}</p> : hint ? <p className="hint">{hint}</p> : null}
    </div>
  );
}

export function Checkbox({
  label,
  description,
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string; description?: string }) {
  return (
    <label className={cn('flex cursor-pointer items-start gap-2.5', className)}>
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded border-input text-primary accent-[hsl(var(--primary))]"
        {...props}
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        {description && <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>}
      </span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-slate-100 text-slate-600 border border-slate-200',
  primary: 'bg-indigo-50 text-indigo-700 border border-indigo-200/60 shadow-sm',
  success: 'bg-emerald-50 text-emerald-700 border border-emerald-200/60 shadow-sm',
  warning: 'bg-amber-50 text-amber-700 border border-amber-200/60 shadow-sm',
  danger: 'bg-rose-50 text-rose-700 border border-rose-200/60 shadow-sm',
  info: 'bg-sky-50 text-sky-700 border border-sky-200/60 shadow-sm',
};

export function Badge({
  tone = 'neutral',
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-bold tracking-wide transition-colors',
        BADGE_TONES[tone],
        className,
      )}
      {...props}
    />
  );
}

/** Maps domain enums to a consistent colour so status reads the same everywhere. */
export const STATUS_TONE: Record<string, BadgeTone> = {
  DRAFT: 'neutral',
  SCHEDULED: 'info',
  ACTIVE: 'primary',
  COMPLETED: 'success',
  CANCELLED: 'neutral',
  INVITED: 'info',
  JOINED: 'primary',
  IN_PROGRESS: 'primary',
  INCOMPLETE: 'warning',
  ABSENT: 'danger',
  STRONG_HIRE: 'success',
  HIRE: 'success',
  CONSIDER: 'warning',
  REJECT: 'danger',
  TECHNICAL: 'primary',
  HR: 'info',
  MIXED: 'neutral',
  EASY: 'success',
  MEDIUM: 'warning',
  HARD: 'danger',
  SENT: 'success',
  PENDING: 'warning',
  FAILED: 'danger',
  SKIPPED: 'neutral',
};

export const humanise = (value: string) =>
  value
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

export const StatusBadge = ({ value, className }: { value: string; className?: string }) => (
  <Badge tone={STATUS_TONE[value] ?? 'neutral'} className={className}>
    {humanise(value)}
  </Badge>
);

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('h-4 w-4 animate-spin text-muted-foreground', className)} />;
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn('relative overflow-hidden rounded-md bg-muted', className)}>
      <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-white/60 to-transparent" />
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-14 text-center', className)}>
      {Icon && (
        <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-muted">
          <Icon className="h-5 w-5 text-muted-foreground" />
        </div>
      )}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Alert({
  tone = 'info',
  title,
  children,
  className,
}: {
  tone?: 'info' | 'warning' | 'danger' | 'success';
  title?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  const tones = {
    info: 'bg-info-soft text-info border-info/20',
    warning: 'bg-warning-soft text-warning border-warning/20',
    danger: 'bg-danger-soft text-danger border-danger/20',
    success: 'bg-success-soft text-success border-success/20',
  };

  return (
    <div className={cn('rounded-md border px-3.5 py-3 text-sm', tones[tone], className)}>
      {title && <p className="font-medium">{title}</p>}
      {children && <div className={cn('leading-relaxed', title && 'mt-0.5 opacity-90')}>{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Score display
// ---------------------------------------------------------------------------

/** Colour reflects how the score reads against a 10-point scale. */
export function scoreTone(value: number): BadgeTone {
  if (value >= 8) return 'success';
  if (value >= 6) return 'primary';
  if (value >= 4) return 'warning';
  return 'danger';
}

const SCORE_BAR_COLOR: Record<BadgeTone, string> = {
  success: 'bg-success',
  primary: 'bg-primary',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
  neutral: 'bg-muted-foreground',
};

export function ScoreBar({
  label,
  value,
  max = 10,
  className,
}: {
  label?: string;
  value: number;
  max?: number;
  className?: string;
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const tone = scoreTone((value / max) * 10);

  return (
    <div className={cn('space-y-1.5', className)}>
      {label && (
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm text-foreground">{label}</span>
          <span className="font-mono text-sm tabular-nums text-muted-foreground">{value.toFixed(1)}</span>
        </div>
      )}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className={cn('h-full rounded-full transition-all', SCORE_BAR_COLOR[tone])} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  className,
}: {
  tabs: Array<{ id: T; label: string; count?: number }>;
  active: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  return (
    <div className={cn('overflow-guard border-b border-border', className)}>
      <div className="flex min-w-max gap-1" role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={active === tab.id}
            onClick={() => onChange(tab.id)}
            className={cn(
              '-mb-px whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors',
              active === tab.id
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground',
            )}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span
                className={cn(
                  'ml-1.5 rounded-full px-1.5 py-0.5 text-xs',
                  active === tab.id ? 'bg-primary-soft text-primary' : 'bg-muted text-muted-foreground',
                )}
              >
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
}) {
  // Escape closes, and the body must not scroll behind the overlay.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;

  const widths = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-3xl' };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-foreground/25 p-4 sm:items-center">
      <div className="absolute inset-0" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn('relative z-10 my-auto w-full animate-scale-in rounded-lg bg-surface shadow-pop', widths[size])}
      >
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-base font-semibold text-foreground">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
        {children && <div className="scroll-area max-h-[70vh] px-4 py-4 sm:max-h-[65vh] sm:px-5">{children}</div>}
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-border px-4 py-3.5 sm:px-5">{footer}</div>}
      </div>
    </div>
  );
}
