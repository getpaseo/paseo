import { View } from "react-native";
import Animated, {
  Easing,
  makeMutable,
  type SharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { useEffect } from "react";

const SYNCED_LOADER_DURATION_MS = 950;
const SYNCED_LOADER_EPOCH_MS = 0;
const DOT_SEQUENCE = [0, 1, 3, 5, 4, 2] as const;
const DOT_COUNT = DOT_SEQUENCE.length;
const GRID_ROWS = 3;
const GRID_COLUMNS = 2;
const SNAKE_SEGMENT_OFFSETS = [0, -1, -2, -3, -4] as const;
const SNAKE_OPACITIES = [1, 0.78, 0.56, 0.34, 0] as const;
const sharedStepProgress = makeMutable(0);
let sharedLoopStarted = false;

function ensureSharedStepLoopStarted(): void {
  if (sharedLoopStarted) {
    return;
  }

  sharedLoopStarted = true;
  const elapsedMs = (Date.now() - SYNCED_LOADER_EPOCH_MS) % SYNCED_LOADER_DURATION_MS;
  sharedStepProgress.value = (elapsedMs / SYNCED_LOADER_DURATION_MS) * DOT_COUNT;
  sharedStepProgress.value = withTiming(
    DOT_COUNT,
    {
      duration: Math.max(1, Math.round(SYNCED_LOADER_DURATION_MS - elapsedMs)),
      easing: Easing.linear,
    },
    (finished) => {
      if (!finished) {
        sharedLoopStarted = false;
        return;
      }
      sharedStepProgress.value = 0;
      sharedStepProgress.value = withRepeat(
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
  useEffect(() => {
    ensureSharedStepLoopStarted();
  }, []);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: 1,
  }));

  const gap = Math.max(1, Math.round(size * 0.12));
  const dotSize = Math.max(2, Math.floor((size - gap * 2) / 3));
  const gridWidth = dotSize * 2 + gap;
  const gridHeight = dotSize * 3 + gap * 2;

  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Animated.View
        style={[
          animatedStyle,
          {
            width: gridWidth,
            height: gridHeight,
          },
        ]}
      >
        {Array.from({ length: DOT_COUNT }).map((_, dotIndex) => {
          const rowIndex = Math.floor(dotIndex / GRID_COLUMNS);
          const columnIndex = dotIndex % GRID_COLUMNS;
          const sequenceIndex = DOT_SEQUENCE.indexOf(dotIndex as (typeof DOT_SEQUENCE)[number]);

          return (
            <SpinnerDot
              key={dotIndex}
              color={color}
              dotSize={dotSize}
              sequenceIndex={sequenceIndex}
              progress={sharedStepProgress}
              style={{
                position: "absolute",
                left: columnIndex * (dotSize + gap),
                top: rowIndex * (dotSize + gap),
              }}
            />
          );
        })}
      </Animated.View>
    </View>
  );
}

function SpinnerDot({
  color,
  dotSize,
  sequenceIndex,
  progress,
  style,
}: {
  color: string;
  dotSize: number;
  sequenceIndex: number;
  progress: SharedValue<number>;
  style: {
    position: "absolute";
    left: number;
    top: number;
  };
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

  return (
    <Animated.View
      style={[
        animatedStyle,
        {
          width: dotSize,
          height: dotSize,
          borderRadius: dotSize / 2,
          backgroundColor: color,
        },
        style,
      ]}
    />
  );
}
