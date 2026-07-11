import { useLayoutEffect, useMemo } from "react";
import { View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { useRetainedPanelActive } from "@/components/retained-panel";

const SYNCED_LOADER_DURATION_MS = 950;
const SYNCED_LOADER_EPOCH_MS = 0;
const DOT_SEQUENCE = [0, 1, 3, 5, 4, 2] as const;
const DOT_COUNT = DOT_SEQUENCE.length;
const GRID_COLUMNS = 2;
const SNAKE_SEGMENT_OFFSETS = [0, -1, -2, -3, -4] as const;
const SNAKE_OPACITIES = [1, 0.78, 0.56, 0.34, 0] as const;
const DOT_KEYS = Array.from({ length: DOT_COUNT }, (_, i) => `dot-${i}`);

function startSyncedStepLoop(progress: SharedValue<number>): void {
  const elapsedMs = (Date.now() - SYNCED_LOADER_EPOCH_MS) % SYNCED_LOADER_DURATION_MS;
  progress.value = (elapsedMs / SYNCED_LOADER_DURATION_MS) * DOT_COUNT;
  progress.value = withTiming(
    DOT_COUNT,
    {
      duration: Math.max(1, Math.round(SYNCED_LOADER_DURATION_MS - elapsedMs)),
      easing: Easing.linear,
    },
    (finished) => {
      if (!finished) {
        return;
      }
      progress.value = 0;
      progress.value = withRepeat(
        withTiming(DOT_COUNT, {
          duration: SYNCED_LOADER_DURATION_MS,
          easing: Easing.linear,
        }),
        -1,
        false,
      );
    },
  );
}

export function SyncedLoader({ size = 10, color }: { size?: number; color: string }) {
  const active = useRetainedPanelActive();
  const stepProgress = useSharedValue(0);

  useLayoutEffect(() => {
    cancelAnimation(stepProgress);
    if (!active) {
      return;
    }
    startSyncedStepLoop(stepProgress);
    return () => {
      cancelAnimation(stepProgress);
    };
  }, [active, stepProgress]);

  const gap = Math.max(1, Math.round(size * 0.12));
  const dotSize = Math.max(2, Math.floor((size - gap * 2) / 3));
  const gridWidth = dotSize * 2 + gap;
  const gridHeight = dotSize * 3 + gap * 2;

  const gridStyle = useMemo(
    () => ({ width: gridWidth, height: gridHeight }),
    [gridHeight, gridWidth],
  );
  const containerStyle = useMemo(
    () =>
      ({
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
      }) as const,
    [size],
  );

  return (
    <View style={containerStyle}>
      <View style={gridStyle}>
        {Array.from({ length: DOT_COUNT }).map((_, dotIndex) => {
          const rowIndex = Math.floor(dotIndex / GRID_COLUMNS);
          const columnIndex = dotIndex % GRID_COLUMNS;
          const sequenceIndex = DOT_SEQUENCE.indexOf(dotIndex as (typeof DOT_SEQUENCE)[number]);

          return (
            <SpinnerDot
              key={DOT_KEYS[dotIndex]}
              color={color}
              dotSize={dotSize}
              sequenceIndex={sequenceIndex}
              progress={stepProgress}
              left={columnIndex * (dotSize + gap)}
              top={rowIndex * (dotSize + gap)}
            />
          );
        })}
      </View>
    </View>
  );
}

function SpinnerDot({
  color,
  dotSize,
  sequenceIndex,
  progress,
  left,
  top,
}: {
  color: string;
  dotSize: number;
  sequenceIndex: number;
  progress: SharedValue<number>;
  left: number;
  top: number;
}) {
  const animatedStyle = useAnimatedStyle(() => {
    const headIndex = Math.floor(progress.value) % DOT_COUNT;
    let opacity = 0;

    for (let segmentIndex = 0; segmentIndex < SNAKE_SEGMENT_OFFSETS.length; segmentIndex += 1) {
      const activeSequenceIndex =
        (headIndex + SNAKE_SEGMENT_OFFSETS[segmentIndex] + DOT_COUNT) % DOT_COUNT;
      if (sequenceIndex === activeSequenceIndex) {
        opacity = SNAKE_OPACITIES[segmentIndex] ?? 0;
        break;
      }
    }

    return {
      opacity,
    };
  });

  const dotStyle = useMemo(
    () => [
      animatedStyle,
      {
        width: dotSize,
        height: dotSize,
        borderRadius: dotSize / 2,
        backgroundColor: color,
        position: "absolute" as const,
        left,
        top,
      },
    ],
    [animatedStyle, dotSize, color, left, top],
  );

  return <Animated.View style={dotStyle} />;
}
