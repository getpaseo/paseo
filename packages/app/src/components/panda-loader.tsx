import { memo, useEffect, useMemo, useState } from "react";
import Animated, {
  Easing,
  cancelAnimation,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import Svg, { Rect } from "react-native-svg";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { PANDA_STAND, PANDA_WORK_FRAMES } from "@/components/panda-frames";
import { PANDA_GRID, buildPandaRuns } from "@/components/panda-sprite";

// 16 frames of small steps, about 7 per second.
const WORK_FRAME_MS = 140;
const SALTO_MS = 950;
const SALTO_REST_MS = 900;

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

/**
 * Loading screen mascot: one somersault, a short rest, again. The finished drawing turns on the
 * compositor instead of being re-rasterised per frame, so its edges never flicker.
 */
export const PandaSalto = memo(function PandaSalto({ pixel = 4 }: { pixel?: number }) {
  const reducedMotion = useReducedMotion();
  const progress = useSharedValue(0);

  useEffect(() => {
    if (reducedMotion) return;
    progress.value = withRepeat(
      withSequence(
        withTiming(1, { duration: SALTO_MS, easing: Easing.inOut(Easing.cubic) }),
        withDelay(SALTO_REST_MS, withTiming(0, { duration: 0 })),
      ),
      -1,
      false,
    );
    return () => cancelAnimation(progress);
  }, [progress, reducedMotion]);

  const style = useAnimatedStyle(() => {
    const p = progress.value;
    const hop = -Math.sin(p * Math.PI) * PANDA_GRID * pixel * 0.28;
    const squash = interpolate(p, [0, 0.12, 0.88, 1], [1, 0.92, 0.92, 1]);
    return {
      transform: [
        { translateY: hop },
        { rotate: `${p * 360}deg` },
        { scaleY: squash },
        { scaleX: 2 - squash },
      ],
    };
  });

  return (
    <Animated.View style={style}>
      <PandaFrameSvg frame={PANDA_STAND} pixel={pixel} label="PandaOS lädt" />
    </Animated.View>
  );
});
