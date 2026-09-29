import { memo, useEffect, useMemo, useState } from "react";
import { useReducedMotion } from "react-native-reanimated";
import Svg, { Rect } from "react-native-svg";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { PANDA_COLUMNS, PANDA_FRAMES, PANDA_ROWS, buildPandaRuns } from "@/components/panda-sprite";

const FRAME_MS = 320;
// One spare row keeps the bob inside the box.
const VIEW_ROWS = PANDA_ROWS + 1;

function nextFrameIndex(index: number): number {
  return (index + 1) % PANDA_FRAMES.length;
}

/** PandaOS's working indicator: a small pixel panda that breathes and blinks while a turn runs. */
export const PandaLoader = memo(function PandaLoader({ pixel = 2 }: { pixel?: number }) {
  const active = useRetainedPanelActive();
  const reducedMotion = useReducedMotion();
  const [frameIndex, setFrameIndex] = useState(0);
  const animate = active && !reducedMotion;

  useEffect(() => {
    if (!animate) return;
    const advance = () => setFrameIndex(nextFrameIndex);
    const timer = setInterval(advance, FRAME_MS);
    return () => clearInterval(timer);
  }, [animate]);

  const runs = useMemo(
    () => buildPandaRuns(PANDA_FRAMES[animate ? frameIndex : 0]!),
    [animate, frameIndex],
  );
  return (
    <Svg
      width={PANDA_COLUMNS * pixel}
      height={VIEW_ROWS * pixel}
      viewBox={`0 0 ${PANDA_COLUMNS} ${VIEW_ROWS}`}
      accessibilityLabel="PandaOS arbeitet"
    >
      {runs.map((run) => (
        <Rect
          key={`${run.x}-${run.y}`}
          x={run.x}
          y={run.y}
          width={run.width}
          height={1}
          fill={run.fill}
        />
      ))}
    </Svg>
  );
});
