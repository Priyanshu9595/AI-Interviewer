'use client';

/**
 * The landing page's single image: a live interview rendered as an inline SVG.
 *
 * Drawn rather than photographed so it stays sharp at any size, needs no
 * network request, and can be tinted entirely from the one brand hue — a stock
 * photo would drag in a second palette and undercut the single-colour design.
 *
 * The animation is real: the waveform is what the product actually measures,
 * and it is what makes the picture read as "listening" rather than "chatting".
 */
export function HeroVisual({ className }: { className?: string }) {
  // A speech-shaped envelope: quiet at the edges, loud in the middle.
  const bars = Array.from({ length: 28 }, (_, i) => {
    const centre = 1 - Math.abs(i - 13.5) / 14;
    return {
      x: 176 + i * 9,
      base: 8 + centre * 30,
      delay: (i * 0.07).toFixed(2),
    };
  });

  return (
    <svg
      viewBox="0 0 640 300"
      className={className}
      role="img"
      aria-label="An AI interviewer listening to a candidate speak, with the conversation being scored live"
      fill="none"
    >
      <defs>
        <linearGradient id="hero-fade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity="0.10" />
          <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity="0" />
        </linearGradient>

        <radialGradient id="hero-glow">
          <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity="0.22" />
          <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Panel */}
      <rect x="0.5" y="0.5" width="639" height="299" rx="16" fill="url(#hero-fade)" stroke="hsl(var(--border))" />

      {/* --- The interviewer ------------------------------------------- */}
      <circle cx="96" cy="150" r="62" fill="url(#hero-glow)" />

      <circle cx="96" cy="150" r="38" fill="hsl(var(--primary))" opacity="0.14" />
      <circle cx="96" cy="150" r="38" stroke="hsl(var(--primary))" strokeOpacity="0.35" />

      {/* Expanding ring: the interviewer is actively listening. */}
      <circle cx="96" cy="150" r="38" stroke="hsl(var(--primary))" strokeOpacity="0.5" fill="none">
        <animate attributeName="r" values="38;62;62" dur="3s" repeatCount="indefinite" />
        <animate attributeName="stroke-opacity" values="0.5;0;0" dur="3s" repeatCount="indefinite" />
      </circle>

      {/* A simple head-and-shoulders mark reads as "interviewer" at a glance. */}
      <circle cx="96" cy="140" r="12" fill="hsl(var(--primary))" />
      <path d="M76 168a20 20 0 0 1 40 0" fill="hsl(var(--primary))" />

      <text x="96" y="228" textAnchor="middle" fontSize="13" fontWeight="600" fill="hsl(var(--foreground))">
        AI interviewer
      </text>
      <text x="96" y="246" textAnchor="middle" fontSize="11" fill="hsl(var(--muted-foreground))">
        listening
      </text>

      {/* --- The candidate speaking ------------------------------------ */}
      {bars.map((bar) => (
        <rect
          key={bar.x}
          x={bar.x}
          width="4"
          rx="2"
          fill="hsl(var(--primary))"
          fillOpacity="0.75"
          y={150 - bar.base / 2}
          height={bar.base}
        >
          <animate
            attributeName="height"
            values={`${bar.base};${bar.base * 2.1};${bar.base * 0.5};${bar.base}`}
            dur="1.8s"
            begin={`${bar.delay}s`}
            repeatCount="indefinite"
          />
          <animate
            attributeName="y"
            values={`${150 - bar.base / 2};${150 - bar.base * 1.05};${150 - bar.base * 0.25};${150 - bar.base / 2}`}
            dur="1.8s"
            begin={`${bar.delay}s`}
            repeatCount="indefinite"
          />
        </rect>
      ))}

      {/* --- What is being measured, live ------------------------------ */}
      <g transform="translate(176 214)">
        {[
          { label: 'Technical', width: 74 },
          { label: 'Communication', width: 104 },
          { label: 'Behavioural', width: 84 },
        ].map((pill, i) => {
          const x = [0, 86, 202][i] ?? 0;
          return (
            <g key={pill.label} transform={`translate(${x} 0)`}>
              <rect width={pill.width} height="22" rx="11" fill="hsl(var(--primary))" fillOpacity="0.10" />
              <text x={pill.width / 2} y="15" textAnchor="middle" fontSize="10.5" fill="hsl(var(--primary))">
                {pill.label}
              </text>
            </g>
          );
        })}
      </g>

      <text x="176" y="264" fontSize="11" fill="hsl(var(--muted-foreground))">
        scored from the conversation, not a questionnaire
      </text>

      {/* --- Live indicator -------------------------------------------- */}
      <g transform="translate(556 30)">
        <circle cx="0" cy="0" r="4" fill="hsl(var(--primary))">
          <animate attributeName="opacity" values="1;0.25;1" dur="1.6s" repeatCount="indefinite" />
        </circle>
        <text x="12" y="4" fontSize="11" fontWeight="500" fill="hsl(var(--muted-foreground))">
          Live
        </text>
      </g>
    </svg>
  );
}
