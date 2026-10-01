import { memo, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useReducedMotion } from "react-native-reanimated";
import Svg, { Rect } from "react-native-svg";
import { withUnistyles } from "react-native-unistyles";
import {
  PANDA_STATUS_FILL_MAPPING,
  PANDA_STATUS_FRAME_MS,
  PANDA_STATUS_LABEL_KEYS,
  pandaStatusRuns,
} from "@/components/panda-status-meta";
import {
  PANDA_STATUS_FRAMES,
  PANDA_STATUS_GRID,
  type PandaMood,
} from "@/components/panda-status-frames";

export type { PandaMood };

const ThemedRect = withUnistyles(Rect);

function useFrameIndex(frameCount: number, animate: boolean): number {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    setIndex(0); // a different frame count means the mood changed; start its loop on frame 1
    if (!animate || frameCount <= 1) return;
    const timer = setInterval(
      () => setIndex((current) => (current + 1) % frameCount),
      PANDA_STATUS_FRAME_MS,
    );
    return () => clearInterval(timer);
  }, [animate, frameCount]);
  return animate ? index : 0;
}

const PandaStatusSvg = memo(function PandaStatusSvg({
  frame,
  grid,
  pixelScale,
  label,
  testID,
}: {
  frame: readonly string[];
  grid: number;
  pixelScale: number;
  label: string;
  testID?: string;
}) {
  const { furRuns, statusRuns } = useMemo(() => pandaStatusRuns(frame), [frame]);
  return (
    <Svg
      width={grid * pixelScale}
      height={grid * pixelScale}
      viewBox={`0 0 ${grid} ${grid}`}
      accessibilityLabel={label}
      testID={testID}
    >
      {furRuns.map((run) => (
        <Rect
          key={`f-${run.x}-${run.y}`}
          x={run.x}
          y={run.y}
          width={run.width}
          height={1}
          fill={run.fill}
        />
      ))}
      {statusRuns.map((run) => (
        <ThemedRect
          key={`s-${run.x}-${run.y}`}
          x={run.x}
          y={run.y}
          width={run.width}
          height={1}
          uniProps={PANDA_STATUS_FILL_MAPPING[run.fill]}
        />
      ))}
    </Svg>
  );
});

/** Cycles this mood's frames on its own timer; isolated so a tick never re-renders PandaStatus. */
const PandaStatusAnimator = memo(function PandaStatusAnimator({
  frames,
  grid,
  pixelScale,
  label,
  animate,
  testID,
}: {
  frames: readonly (readonly string[])[];
  grid: number;
  pixelScale: number;
  label: string;
  animate: boolean;
  testID?: string;
}) {
  const index = useFrameIndex(frames.length, animate);
  // A mood switch renders new (shorter) frames before the reset effect below has run; modulo
  // keeps that one transient render in bounds instead of reading past the new array's end.
  const safeIndex = index % frames.length;
  return (
    <PandaStatusSvg
      frame={frames[safeIndex]!}
      grid={grid}
      pixelScale={pixelScale}
      label={label}
      testID={testID}
    />
  );
});

export interface PandaStatusProps {
  /** run chews bamboo, ask raises a paw, err startles, sleep dozes off. */
  mood: PandaMood;
  size: "small" | "large";
  /** CSS-pixel size of one sprite pixel. Defaults to a sensible size per `size`. */
  pixelScale?: number;
  /** Off (or when the OS prefers reduced motion) freezes on the mood's first frame. */
  animate?: boolean;
  testID?: string;
  accessibilityLabel?: string;
}

/** PandaOS's status mascot: the same pixel panda used for the loader and header, in one place. */
export const PandaStatus = memo(function PandaStatus({
  mood,
  size,
  pixelScale = size === "large" ? 4 : 2,
  animate = true,
  testID,
  accessibilityLabel,
}: PandaStatusProps) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  return (
    <PandaStatusAnimator
      frames={PANDA_STATUS_FRAMES[size][mood]}
      grid={PANDA_STATUS_GRID[size]}
      pixelScale={pixelScale}
      label={accessibilityLabel ?? t(PANDA_STATUS_LABEL_KEYS[mood])}
      animate={animate && !reducedMotion}
      testID={testID}
    />
  );
});
