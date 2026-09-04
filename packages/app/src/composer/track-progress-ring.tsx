import type { ReactElement } from "react";
import Svg, { Circle } from "react-native-svg";
import { withUnistyles } from "react-native-unistyles";
import { STATUS_RING_SIZE, STATUS_RING_STROKE } from "@/components/status-ring/geometry";
import type { Theme } from "@/styles/theme";

// Sized from the running indicator rather than chosen: the pill bar draws state dots and running
// rings on the same line, and a mark that reports a fraction is one more mark on that line. Its
// own number would make the tracker that carries it look louder than the one that does not.
const CENTER = STATUS_RING_SIZE / 2;
const RADIUS = (STATUS_RING_SIZE - STATUS_RING_STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * A determinate arc: one circle for the track, one dashed to the fraction and rotated so it
 * starts at twelve and fills clockwise — the direction every progress ring in the platform UIs
 * turns, and the one the eye reads as a clock rather than a countdown.
 *
 * Themed at this boundary rather than per circle, the way the sidebar's check indicator does it
 * (components/sidebar/workspace-meta-row/check-indicator.tsx). `useUnistyles()` is forbidden and
 * an SVG stroke is not a style, so the colours arrive as props through `withUnistyles`.
 */
function TrackProgressRingSvg({
  progress,
  trackColor,
  fillColor,
}: {
  progress: number;
  trackColor: string;
  fillColor: string;
}): ReactElement {
  const filled = Math.max(0, Math.min(1, progress));
  return (
    <Svg width={STATUS_RING_SIZE} height={STATUS_RING_SIZE} pointerEvents="none">
      <Circle
        cx={CENTER}
        cy={CENTER}
        r={RADIUS}
        stroke={trackColor}
        strokeWidth={STATUS_RING_STROKE}
        fill="none"
      />
      {filled === 0 ? null : (
        <Circle
          cx={CENTER}
          cy={CENTER}
          r={RADIUS}
          stroke={fillColor}
          strokeWidth={STATUS_RING_STROKE}
          strokeLinecap="round"
          strokeDasharray={`${CIRCUMFERENCE * filled} ${CIRCUMFERENCE}`}
          transform={`rotate(-90 ${CENTER} ${CENTER})`}
          fill="none"
        />
      )}
    </Svg>
  );
}

const ringColors = (theme: Theme) => ({
  trackColor: theme.colors.surface3,
  fillColor: theme.colors.statusSuccess,
});

const ThemedTrackProgressRing = withUnistyles(TrackProgressRingSvg);

/** The share of a tracker's items that are done, as the mark leading its pill. */
export function ComposerTrackProgressRing({ progress }: { progress: number }): ReactElement {
  return <ThemedTrackProgressRing progress={progress} uniProps={ringColors} />;
}
