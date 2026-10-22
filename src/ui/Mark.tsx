/**
 * The zed gnome: Mic Gnome's conical hat, with the beard drawn as a Z in
 * pixels, and the orange nose as the one cell of the diagonal that is lit.
 *
 * Drawn rather than placed, so it takes its greys from the theme and stays
 * crisp at 16px, which is where a favicon lives (public/favicon.svg is the same
 * drawing with the light theme's colours baked in).
 *
 * `framed` sets him in the hairline square the other gnomes sit in, so the
 * family's marks read as one set in the header and the tab.
 */
const BEARD = [[8, 13.8], [12, 13.8], [16, 13.8], [20, 13.8], [12, 21.8], [8, 25.8], [12, 25.8], [16, 25.8], [20, 25.8]]

export function Mark({ size = 26, framed = false }: { size?: number; framed?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden focusable="false">
      {framed && <rect x="1.5" y="1.5" width="29" height="29" fill="var(--color-paper)" stroke="var(--color-mute)" strokeWidth="1.2" />}
      <g className="gnome">
        <path d="M6.2 12.8 L14.7 3.6 Q16 2.4 17.3 3.6 L25.8 12.8 z" fill="var(--color-mute)" />
        <g fill="var(--color-mute)" fillOpacity="0.45">
          {BEARD.map(([x, y]) => <rect key={`${x},${y}`} x={x} y={y} width="3.6" height="3.6" />)}
        </g>
        <rect x="16" y="17.8" width="3.6" height="3.6" fill="var(--color-orange)" />
      </g>
    </svg>
  )
}
