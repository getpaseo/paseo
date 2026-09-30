import { memo, useEffect, useMemo } from "react";
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
import { PANDA_STAND } from "@/components/panda-frames";
import { PANDA_GRID, buildPandaRuns } from "@/components/panda-sprite";
import { PandaStatus } from "@/components/panda-status";

const SALTO_MS = 950;
const SALTO_REST_MS = 900;

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

/** PandaOS's working indicator: the run-mood panda, chewing bamboo while a turn runs. */
export const PandaLoader = memo(function PandaLoader({ pixel = 1 }: { pixel?: number }) {
  const active = useRetainedPanelActive();
  return <PandaStatus mood="run" size="large" pixelScale={pixel} animate={active} />;
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
