'use client';

/**
 * Decorative SVG lattice — a hex/triangular grid that echoes the
 * geometry of the Shamarx symbol. Faint enough to be atmosphere,
 * not pattern.
 */
export function Lattice({ className = '' }: { className?: string }) {
  return (
    <svg
      aria-hidden
      className={`pointer-events-none absolute inset-0 h-full w-full ${className}`}
      preserveAspectRatio="xMidYMid slice"
    >
      <defs>
        <pattern
          id="shamarx-lattice"
          x="0"
          y="0"
          width="60"
          height="52"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(0)"
        >
          <path
            d="M30 0 L60 17 L60 35 L30 52 L0 35 L0 17 Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="0.6"
            opacity="0.6"
          />
        </pattern>
        <radialGradient id="shamarx-lattice-fade" cx="50%" cy="50%" r="60%">
          <stop offset="0%" stopColor="white" stopOpacity="1" />
          <stop offset="100%" stopColor="white" stopOpacity="0" />
        </radialGradient>
        <mask id="shamarx-lattice-mask">
          <rect width="100%" height="100%" fill="url(#shamarx-lattice-fade)" />
        </mask>
      </defs>
      <rect
        width="100%"
        height="100%"
        fill="url(#shamarx-lattice)"
        mask="url(#shamarx-lattice-mask)"
        className="text-signal/25"
      />
    </svg>
  );
}
