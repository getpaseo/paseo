import Svg, { Circle } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import type { CheckStatus } from "./check-status";
import type { ChecksSummary } from "./checks-summary";

/**
 * Geometry in a 20-unit box scaled to the requested size, so the ring keeps its stroke
 * weight next to the header text at any size.
 */
const VIEW_BOX = 20;
const STROKE_WIDTH = 3;
const CENTER = VIEW_BOX / 2;
const RADIUS = (VIEW_BOX - STROKE_WIDTH) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** Blank arc between segments so two adjacent colours stay legible at 20px. */
const SEGMENT_GAP = 2;
/** Floor for a segment, so one failure among twenty checks is still a visible mark. */
const MIN_SEGMENT = 1.5;

type ChecksPalette = Record<CheckStatus, string> & { track: string };

const paletteMapping = (theme: Theme): { palette: ChecksPalette } => ({
  palette: {
    failure: theme.colors.statusDanger,
    pending: theme.colors.statusWarning,
    success: theme.colors.statusSuccess,
    skipped: theme.colors.foregroundExtraMuted,
    track: theme.colors.surface3,
  },
});

interface RingSegment {
  status: CheckStatus;
  /** Painted arc length. */
  dash: number;
  /** Distance from twelve o'clock to where this segment starts. */
  offset: number;
}

/**
 * Each status gets a slice of the circle proportional to its share of the run, laid out
 * clockwise from twelve. Gaps come out of the painted arc rather than the layout, so the
 * slices still add up to the whole circle and the last one lands back at twelve.
 */
function buildSegments(summary: ChecksSummary): RingSegment[] {
  const segments: RingSegment[] = [];
  let offset = 0;
  for (const part of summary.parts) {
    const arc = (part.count / summary.total) * CIRCUMFERENCE;
    // A single status owns the whole circle, and a gap there would read as a stray notch.
    const dash =
      summary.parts.length === 1 ? CIRCUMFERENCE : Math.max(arc - SEGMENT_GAP, MIN_SEGMENT);
    segments.push({ status: part.status, dash, offset });
    offset += arc;
  }
  return segments;
}

function ChecksRingSvg({
  summary,
  size,
  palette,
}: {
  summary: ChecksSummary;
  size: number;
  palette: ChecksPalette;
}) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox={`0 0 ${VIEW_BOX} ${VIEW_BOX}`}
      style={ringStyles.svg}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Circle
        cx={CENTER}
        cy={CENTER}
        r={RADIUS}
        fill="none"
        stroke={palette.track}
        strokeWidth={STROKE_WIDTH}
      />
      {buildSegments(summary).map((segment) => (
        <Circle
          key={segment.status}
          cx={CENTER}
          cy={CENTER}
          r={RADIUS}
          fill="none"
          stroke={palette[segment.status]}
          strokeWidth={STROKE_WIDTH}
          strokeDasharray={`${segment.dash} ${CIRCUMFERENCE - segment.dash}`}
          strokeDashoffset={-segment.offset}
        />
      ))}
    </Svg>
  );
}

const ThemedChecksRingSvg = withUnistyles(ChecksRingSvg);

/** A change request's CI as one glyph: the run's statuses in proportion, worst first. */
export function ChecksRing({ summary, size }: { summary: ChecksSummary; size: number }) {
  return <ThemedChecksRingSvg summary={summary} size={size} uniProps={paletteMapping} />;
}

const ringStyles = StyleSheet.create(() => ({
  svg: {
    // SVG strokes start at three o'clock; the ring reads clockwise from twelve.
    transform: [{ rotate: "-90deg" }],
  },
}));
