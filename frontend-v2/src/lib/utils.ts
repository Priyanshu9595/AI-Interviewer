import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const asDate = (value: string | Date) => (value instanceof Date ? value : new Date(value));

export const formatDate = (value: string | Date) =>
  asDate(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

export const formatTime = (value: string | Date) =>
  asDate(value).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export const formatDateTime = (value: string | Date) =>
  asDate(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

/** "in 3 days", "2 hours ago" — falls back to an absolute date beyond a month. */
export function relativeTime(value: string | Date): string {
  const diffMs = asDate(value).getTime() - Date.now();
  const abs = Math.abs(diffMs);

  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['minute', 60_000],
    ['hour', 3_600_000],
    ['day', 86_400_000],
    ['week', 604_800_000],
  ];

  if (abs < 60_000) return 'just now';
  if (abs > 2_592_000_000) return formatDate(value);

  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  let chosen: [Intl.RelativeTimeFormatUnit, number] = units[0]!;
  for (const unit of units) if (abs >= unit[1]) chosen = unit;

  return rtf.format(Math.round(diffMs / chosen[1]), chosen[0]);
}

export const formatDuration = (minutes: number) => {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
};

export const formatClock = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};

/** Formats a Date for a datetime-local input, which expects local time. */
export function toDateTimeLocal(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

export const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');

/** Deterministic pastel avatar colour derived from the name. */
export function avatarColor(name: string): string {
  const palette = [
    'bg-indigo-100 text-indigo-700',
    'bg-emerald-100 text-emerald-700',
    'bg-amber-100 text-amber-700',
    'bg-sky-100 text-sky-700',
    'bg-rose-100 text-rose-700',
    'bg-violet-100 text-violet-700',
    'bg-teal-100 text-teal-700',
  ];

  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return palette[Math.abs(hash) % palette.length]!;
}

export const truncate = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
