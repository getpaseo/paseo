import { memo, useEffect, useMemo, useState } from "react";
import { useReducedMotion } from "react-native-reanimated";
import Svg, { Rect } from "react-native-svg";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { PANDA_SALTO_FRAMES, PANDA_WORK_FRAMES } from "@/components/panda-frames";
import { PANDA_GRID, buildPandaRuns } from "@/components/panda-sprite";

const WORK_FRAME_MS = 280;
const SALTO_FRAME_MS = 70;
// The somersault rests on the first frame so the loop reads as hop, pause, hop.
const SALTO_PAUSE_FRAMES = 8;

function useFrameIndex(frameCount: number, intervalMs: number, animate: boolean): number {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!animate) return;
    const advance = () => setIndex((current) => (current + 1) % frameCount);
    const timer = setInterval(advance, intervalMs);
    return () => clearInterval(timer);
  }, [animate, frameCount, intervalMs]);
  return animate ? index : 0;
}

const PandaFrameSvg = memo(function PandaFrameSvg({
  frame,
  pixel,
  label,
}: {
  frame: readonly string[];
  pixel: number;
  label: string;
}) {
  const runs = useMemo(() => buildPandaRuns(frame), [frame]);
  return (
    <Svg
      width={PANDA_GRID * pixel}
      height={PANDA_GRID * pixel}
      viewBox={`0 0 ${PANDA_GRID} ${PANDA_GRID}`}
      accessibilityLabel={label}
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

/** PandaOS's working indicator: the panda chews bamboo, blinks and thinks while a turn runs. */
export const PandaLoader = memo(function PandaLoader({ pixel = 1 }: { pixel?: number }) {
  const active = useRetainedPanelActive();
  const reducedMotion = useReducedMotion();
  const index = useFrameIndex(PANDA_WORK_FRAMES.length, WORK_FRAME_MS, active && !reducedMotion);
  return <PandaFrameSvg frame={PANDA_WORK_FRAMES[index]!} pixel={pixel} label="PandaOS arbeitet" />;
});

/** Loading screen mascot: a somersault, a short rest, again. */
export const PandaSalto = memo(function PandaSalto({ pixel = 4 }: { pixel?: number }) {
  const reducedMotion = useReducedMotion();
  const total = PANDA_SALTO_FRAMES.length + SALTO_PAUSE_FRAMES;
  const step = useFrameIndex(total, SALTO_FRAME_MS, !reducedMotion);
  const frame = PANDA_SALTO_FRAMES[step < PANDA_SALTO_FRAMES.length ? step : 0]!;
  return <PandaFrameSvg frame={frame} pixel={pixel} label="PandaOS lädt" />;
});
