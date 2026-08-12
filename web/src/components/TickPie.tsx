/**
 * A 10px dial that fills as a scheduler tick approaches — the header funnel's countdown for 번역
 * (`herald-watch`) and 렌더 (`herald-convert`). `fraction` comes from `tickPhase` (`tickSchedule.ts`);
 * this file only draws it.
 *
 * It FILLS rather than drains: empty is "the tick just ran", full is "it is about to". A reviewer
 * reads the strip left to right for how much work is queued, and a wedge that grows alongside the
 * numbers says "this is about to move" — 완성되면 돈다. Draining would say the opposite with the same
 * pixels.
 *
 * The wedge is a `<circle>` stroked as wide as its own diameter, so the stroke's inner edge closes at
 * the centre and a dash renders as a pie slice rather than an arc — which is why there is no path
 * arithmetic here, and no `A` command whose large-arc flag flips wrong at exactly half past.
 *
 * No animation and no seconds hand. It re-renders once a minute with the shared clock (`useNow`),
 * which is all the resolution a two-hour cadence deserves, and a smoothly sweeping icon in a header
 * pulls the eye away from the board it is annotating.
 */

/** A 20-unit box drawn at 10px: every radius below is a whole or half unit, and stays crisp at 2×. */
const VIEWBOX = 20;
const CENTER = VIEWBOX / 2;
const TRACK_RADIUS = 8.5;
/** Half the track, stroked `TRACK_RADIUS` wide — 0 to 8.5 from the centre, i.e. a filled disc. */
const WEDGE_RADIUS = TRACK_RADIUS / 2;
const WEDGE_CIRCUMFERENCE = 2 * Math.PI * WEDGE_RADIUS;

export function TickPie({ fraction, label }: { fraction: number; label: string }) {
  return (
    <svg
      role="img"
      // NOT an SVG `<title>` child, which is the obvious way to caption a graphic and the wrong one
      // here: `<title>` lands in `textContent`, and `App.tsx` keeps each funnel stage's text exactly
      // its own so a test can read one stage at a time. `aria-label` names the element for a screen
      // reader without becoming page text; the pointer gets the same sentence from the `title` on the
      // span wrapping this, in `App.tsx`.
      aria-label={label}
      viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
      width="10"
      height="10"
      // `shrink-0` for the reason the whole header row is — see `App.tsx`'s comment on that. A dial
      // squeezed into an ellipse would read as a different shape, not as a narrower one.
      className="block shrink-0"
    >
      {/* The full circle, always. Without it a just-fired tick would be a gap in the strip, which is
          indistinguishable from an icon that failed to render. */}
      <circle
        data-testid="tick-pie-track"
        cx={CENTER}
        cy={CENTER}
        r={TRACK_RADIUS}
        strokeWidth={2}
        className="fill-none stroke-line"
      />
      {/* An SVG circle starts at 3 o'clock and runs clockwise, so the quarter-turn back is what makes
          this a clock face. Rounded to four decimals: the dash is in viewBox units, so that is a
          ten-thousandth of a 20-unit box — well past invisible, and it keeps the attribute readable. */}
      <circle
        data-testid="tick-pie-wedge"
        cx={CENTER}
        cy={CENTER}
        r={WEDGE_RADIUS}
        strokeWidth={TRACK_RADIUS}
        strokeDasharray={`${(WEDGE_CIRCUMFERENCE * fraction).toFixed(4)} ${WEDGE_CIRCUMFERENCE.toFixed(4)}`}
        transform={`rotate(-90 ${CENTER} ${CENTER})`}
        className="fill-none stroke-mint"
      />
    </svg>
  );
}
