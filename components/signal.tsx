export function Signal() {
  return (
    <div className="signal" aria-hidden="true">
      <svg viewBox="0 0 540 350" fill="none">
        <defs>
          <linearGradient id="signal-line" x1="80" y1="300" x2="460" y2="20">
            <stop stopColor="var(--lime)" stopOpacity=".05" />
            <stop offset=".5" stopColor="var(--lime)" stopOpacity=".9" />
            <stop offset="1" stopColor="var(--lime)" stopOpacity=".12" />
          </linearGradient>
          <radialGradient id="signal-glow">
            <stop stopColor="var(--lime)" stopOpacity=".1" />
            <stop offset="1" stopColor="var(--lime)" stopOpacity="0" />
          </radialGradient>
          <filter id="blur">
            <feGaussianBlur stdDeviation="6" />
          </filter>
        </defs>
        <ellipse cx="280" cy="175" rx="240" ry="165" fill="url(#signal-glow)" />
        <g className="signal-orbit" transform="rotate(-24 280 175)">
          {Array.from({ length: 31 }, (_, i) => {
            const y = 42 + i * 8.8;
            const width = Math.sin((i / 30) * Math.PI) * 152 + 35;
            return (
              <ellipse
                key={i}
                cx={280 + Math.sin((i / 30) * Math.PI * 2) * 22}
                cy={y}
                rx={width}
                ry={22 + Math.sin((i / 30) * Math.PI) * 17}
                stroke="url(#signal-line)"
                strokeWidth=".8"
              />
            );
          })}
          <ellipse
            cx="280"
            cy="175"
            rx="231"
            ry="91"
            stroke="var(--lime)"
            strokeOpacity=".22"
            strokeWidth=".7"
            strokeDasharray="2 5"
          />
        </g>
        <g stroke="var(--muted)" strokeOpacity=".4" strokeWidth=".7">
          <path d="M66 64h12m-6-6v12M451 282h12m-6-6v12M437 49h8m-4-4v8" />
          <path d="M99 272h50l29-29M405 111l31-31h40" />
        </g>
        <circle cx="178" cy="243" r="3" fill="var(--lime)" />
        <circle cx="405" cy="111" r="3" fill="var(--lime)" />
        <circle
          cx="178"
          cy="243"
          r="11"
          stroke="var(--lime)"
          strokeOpacity=".2"
        />
        <text
          x="60"
          y="298"
          fill="var(--muted)"
          fontSize="9"
          fontFamily="monospace"
          letterSpacing="2"
        >
          OBSERVE. CONNECT. UNDERSTAND.
        </text>
        <text
          x="415"
          y="66"
          fill="var(--muted)"
          fontSize="8"
          fontFamily="monospace"
        >
          PX / 001
        </text>
      </svg>
      <span className="signal-caption">A CHANGE IN PERSPECTIVE.</span>
    </div>
  );
}
