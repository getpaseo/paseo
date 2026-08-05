import Svg, { Circle, Path } from "react-native-svg";
import { withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { toFilledQuarters, type CheckSummary } from "./check-summary";

/**
 * Geometry in a 24-unit box scaled to the icon size, so the stroke weight matches the
 * lucide icons sitting next to it in the row. The outline radius leaves half the stroke
 * inside the box on each side; the pie is inset far enough to read as a separate shape
 * rather than a thick ring.
 */
const VIEW_BOX = 24;
const STROKE_WIDTH = 2;
const OUTLINE_RADIUS = (VIEW_BOX - STROKE_WIDTH) / 2;
const CENTER = VIEW_BOX / 2;
const PIE_RADIUS = 7;

const CHECK_PATH = "M8 12.5 L11 15.5 L16.5 9";
const CROSS_PATH = "M8.5 8.5 L15.5 15.5 M15.5 8.5 L8.5 15.5";

/**
 * A change request's CI as one glyph: a check inside a circle when everything passed, a
 * cross when anything failed, and a pie filling clockwise from twelve while the run is
 * still going. The three share the circle so a row's CI always occupies the same shape and
 * only its interior changes.
 */
function CheckIndicatorSvg({
  summary,
  size,
  color,
}: {
  summary: CheckSummary;
  size: number;
  color: string;
}) {
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${VIEW_BOX} ${VIEW_BOX}`}>
      <Circle
        cx={CENTER}
        cy={CENTER}
        r={OUTLINE_RADIUS}
        stroke={color}
        strokeWidth={STROKE_WIDTH}
        fill="none"
      />
      {summary.state === "running" ? (
        <Pie fraction={toFilledQuarters(summary)} color={color} />
      ) : (
        <Path
          d={summary.state === "passed" ? CHECK_PATH : CROSS_PATH}
          stroke={color}
          strokeWidth={STROKE_WIDTH}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      )}
    </Svg>
  );
}

/**
 * A filled wedge from the centre, starting at twelve o'clock and sweeping clockwise. A full
 * circle is drawn as a circle rather than an arc: an arc whose start and end points
 * coincide has nothing to sweep between and paints nothing at all.
 */
function Pie({ fraction, color }: { fraction: number; color: string }) {
  if (fraction <= 0) return null;
  if (fraction >= 1) {
    return <Circle cx={CENTER} cy={CENTER} r={PIE_RADIUS} fill={color} />;
  }

  const angle = fraction * 2 * Math.PI;
  const endX = CENTER + PIE_RADIUS * Math.sin(angle);
  const endY = CENTER - PIE_RADIUS * Math.cos(angle);
  const largeArc = fraction > 0.5 ? 1 : 0;
  const d = [
    `M ${CENTER} ${CENTER}`,
    `L ${CENTER} ${CENTER - PIE_RADIUS}`,
    `A ${PIE_RADIUS} ${PIE_RADIUS} 0 ${largeArc} 1 ${endX} ${endY}`,
    "Z",
  ].join(" ");
  return <Path d={d} fill={color} />;
}

const ThemedCheckIndicatorSvg = withUnistyles(CheckIndicatorSvg);

/**
 * Passing CI is the uneventful case and asks nothing of the reader, so it gets the quiet
 * tier — green enough to name the state, close enough to the subtitle's weight that a
 * sidebar full of them doesn't bury the one red row. Failure and a run still deciding keep
 * real colour, because those are the two that want something from you.
 */
const COLOR_MAPPINGS: Record<CheckSummary["state"], (theme: Theme) => { color: string }> = {
  passed: (theme) => ({ color: theme.colors.statusMutedSuccess }),
  failed: (theme) => ({ color: theme.colors.statusMutedDanger }),
  running: (theme) => ({ color: theme.colors.statusMutedWarning }),
};

export function CheckIndicator({ summary, size }: { summary: CheckSummary; size: number }) {
  return (
    <ThemedCheckIndicatorSvg
      summary={summary}
      size={size}
      uniProps={COLOR_MAPPINGS[summary.state]}
    />
  );
}
