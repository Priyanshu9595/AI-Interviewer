'use client';

import React, { useId, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * Chart palette. Values come from the validated reference palette and were
 * re-checked against this app's white card surface:
 *   - series pair (blue/orange): all six checks PASS
 *   - ordinal blue ramp: monotone L, visible step gaps, light end clears 2:1
 *
 * A red/green outcome palette was tried and rejected — red↔green measures
 * ΔE 4.1 under deuteranopia, so recommendation outcomes use the ordinal ramp
 * plus an always-visible text label rather than colour alone.
 */
export const VIZ = {
  series: ['#2a78d6', '#eb6834'],
  /** Strongest → weakest. Dark = top of the scale. */
  ordinal: ['#184f95', '#2a78d6', '#5598e7', '#86b6ef'],
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  ink: '#0b0b0b',
  muted: '#898781',
} as const;

// ---------------------------------------------------------------------------
// Shared chrome
// ---------------------------------------------------------------------------

export function ChartFrame({
  title,
  description,
  legend,
  children,
  className,
}: {
  title: string;
  description?: string;
  legend?: Array<{ label: string; color: string }>;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <figure className={cn('card p-5', className)}>
      <figcaption className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>

        {/* A legend is always present for two or more series. */}
        {legend && legend.length >= 2 && (
          <ul className="flex flex-wrap gap-3">
            {legend.map((item) => (
              <li key={item.label} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="h-2 w-2 rounded-full" style={{ background: item.color }} aria-hidden />
                {item.label}
              </li>
            ))}
          </ul>
        )}
      </figcaption>

      {children}
    </figure>
  );
}

/**
 * Positioned as a percentage of the container because the SVG scales with its
 * viewBox — pixel coordinates from the viewBox would drift at other widths.
 */
function Tooltip({ leftPct, children }: { leftPct: number; children: React.ReactNode }) {
  // Keep the box inside the frame at the extremes.
  const clamped = Math.max(8, Math.min(92, leftPct));

  return (
    <div
      className="pointer-events-none absolute top-1 z-10 -translate-x-1/2 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs shadow-pop"
      style={{ left: `${clamped}%` }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Horizontal labelled bars
// ---------------------------------------------------------------------------

export interface BarDatum {
  label: string;
  value: number;
  color?: string;
  /** Secondary text shown after the value, e.g. "of 24". */
  note?: string;
}

/**
 * Rows of label + track + value. Because every row carries its own text label
 * and number, colour is reinforcement rather than the identity channel.
 */
export function BarList({
  data,
  max,
  format = (v) => String(v),
  color = VIZ.series[0],
  emptyMessage = 'No data yet.',
}: {
  data: BarDatum[];
  max?: number;
  format?: (value: number) => string;
  color?: string;
  emptyMessage?: string;
}) {
  if (!data.length) {
    return <p className="py-8 text-center text-sm text-muted-foreground">{emptyMessage}</p>;
  }

  const ceiling = max ?? Math.max(...data.map((d) => d.value), 1);

  return (
    <ul className="space-y-2.5">
      {data.map((d) => {
        const pct = ceiling > 0 ? Math.max(0, (d.value / ceiling) * 100) : 0;

        return (
          <li key={d.label} className="grid grid-cols-[8.5rem_1fr_auto] items-center gap-3">
            <span className="truncate text-sm text-foreground" title={d.label}>
              {d.label}
            </span>

            <span className="h-2.5 w-full overflow-hidden rounded-sm" style={{ background: '#f1f0ec' }}>
              {/* Rounded only on the data end, anchored to the baseline. */}
              <span
                className="block h-full transition-[width] duration-500"
                style={{
                  width: `${Math.max(pct, d.value > 0 ? 1.5 : 0)}%`,
                  background: d.color ?? color,
                  borderRadius: '0 4px 4px 0',
                }}
              />
            </span>

            <span className="whitespace-nowrap text-right text-sm tabular-nums text-muted-foreground">
              {format(d.value)}
              {d.note && <span className="ml-1 text-xs">{d.note}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Two-series area/line over time
// ---------------------------------------------------------------------------

export interface TimePoint {
  date: string;
  [series: string]: string | number;
}

export function TimeSeries({
  data,
  series,
  height = 200,
}: {
  data: TimePoint[];
  series: Array<{ key: string; label: string; color: string }>;
  height?: number;
}) {
  const gradientId = useId();
  const [hover, setHover] = useState<number | null>(null);

  if (data.length < 2) {
    return <p className="py-10 text-center text-sm text-muted-foreground">Not enough activity to plot yet.</p>;
  }

  const W = 720;
  const H = height;
  const PAD = { top: 12, right: 12, bottom: 24, left: 30 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const values = data.flatMap((d) => series.map((s) => Number(d[s.key] ?? 0)));
  // A flat-zero dataset still needs a sane axis.
  const maxValue = Math.max(...values, 1);
  const ceiling = Math.ceil(maxValue / 4) * 4 || 4;

  const x = (i: number) => PAD.left + (i / (data.length - 1)) * plotW;
  const y = (v: number) => PAD.top + plotH - (v / ceiling) * plotH;

  const linePath = (key: string) =>
    data.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(Number(d[key] ?? 0)).toFixed(1)}`).join(' ');

  const areaPath = (key: string) =>
    `${linePath(key)} L${x(data.length - 1).toFixed(1)},${(PAD.top + plotH).toFixed(1)} L${PAD.left},${(
      PAD.top + plotH
    ).toFixed(1)} Z`;

  const ticks = [0, ceiling / 2, ceiling];
  const hovered = hover != null ? data[hover] : null;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        style={{ height }}
        role="img"
        aria-label={`Activity over time: ${series.map((s) => s.label).join(' and ')}`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - rect.left) / rect.width) * W;
          const ratio = (px - PAD.left) / plotW;
          setHover(Math.max(0, Math.min(data.length - 1, Math.round(ratio * (data.length - 1)))));
        }}
      >
        <defs>
          {series.map((s) => (
            <linearGradient key={s.key} id={`${gradientId}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity="0.16" />
              <stop offset="100%" stopColor={s.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>

        {/* Recessive gridlines */}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke={VIZ.grid} strokeWidth="1" />
            <text x={PAD.left - 6} y={y(t) + 3.5} textAnchor="end" fontSize="10" fill={VIZ.muted}>
              {Math.round(t)}
            </text>
          </g>
        ))}

        {series.map((s) => (
          <path key={`area-${s.key}`} d={areaPath(s.key)} fill={`url(#${gradientId}-${s.key})`} />
        ))}

        {series.map((s) => (
          <path
            key={`line-${s.key}`}
            d={linePath(s.key)}
            fill="none"
            stroke={s.color}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}

        {/* Crosshair + markers on hover */}
        {hover != null && (
          <>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={PAD.top}
              y2={PAD.top + plotH}
              stroke={VIZ.axis}
              strokeWidth="1"
              strokeDasharray="3 3"
            />
            {series.map((s) => (
              <circle
                key={`dot-${s.key}`}
                cx={x(hover)}
                cy={y(Number(data[hover]?.[s.key] ?? 0))}
                r="4.5"
                fill={s.color}
                stroke="#ffffff"
                strokeWidth="2"
              />
            ))}
          </>
        )}

        {/* Sparse date labels so they never collide */}
        {data.map((d, i) =>
          i % Math.ceil(data.length / 6) === 0 || i === data.length - 1 ? (
            <text key={d.date} x={x(i)} y={H - 6} textAnchor="middle" fontSize="10" fill={VIZ.muted}>
              {d.date}
            </text>
          ) : null,
        )}
      </svg>

      {hovered && hover != null && (
        <Tooltip leftPct={(x(hover) / W) * 100}>
          <div style={{ minWidth: 110 }}>
            <p className="font-medium text-foreground">{hovered.date}</p>
            {series.map((s) => (
              <p key={s.key} className="mt-0.5 flex items-center gap-1.5 text-muted-foreground">
                <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                {s.label}: <span className="tabular-nums text-foreground">{Number(hovered[s.key] ?? 0)}</span>
              </p>
            ))}
          </div>
        </Tooltip>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stat tile
// ---------------------------------------------------------------------------

export function StatTile({
  label,
  value,
  sub,
  className,
}: {
  label: string;
  value: string | number;
  sub?: string;
  className?: string;
}) {
  return (
    <div className={cn('card p-4', className)}>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight text-foreground">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}
