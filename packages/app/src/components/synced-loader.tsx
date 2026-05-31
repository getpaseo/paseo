import { View } from "react-native";
import Animated, { makeMutable, type SharedValue, useAnimatedStyle } from "react-native-reanimated";
import { useEffect, useMemo } from "react";

const SYNCED_LOADER_DURATION_MS = 950;
const SYNCED_LOADER_EPOCH_MS = 0;
const DOT_SEQUENCE = [0, 1, 3, 5, 4, 2] as const;
const DOT_COUNT = DOT_SEQUENCE.length;
const GRID_COLUMNS = 2;
const SNAKE_SEGMENT_OFFSETS = [0, -1, -2, -3, -4] as const;
const SNAKE_OPACITIES = [1, 0.78, 0.56, 0.34, 0] as const;
const DOT_KEYS = Array.from({ length: DOT_COUNT }, (_, i) => `dot-${i}`);
// The snake's head only moves at discrete dot boundaries — SpinnerDot opacity is
// a step function of Math.floor(progress) — so the loader needs ~DOT_COUNT
// updates per cycle, not one per display frame.
const SYNCED_LOADER_STEP_MS = SYNCED_LOADER_DURATION_MS / DOT_COUNT;

const sharedStepProgress = makeMutable(0);
let sharedStepTimer: ReturnType<typeof setInterval> | null = null;
let mountedLoaderCount = 0;

// Head index derived from a fixed epoch, so every loader stays in phase across
// mounts (and clients/restarts) without any running animation to read from.
function currentSnakeStep(): number {
  const elapsedMs = (Date.now() - SYNCED_LOADER_EPOCH_MS) % SYNCED_LOADER_DURATION_MS;
  return Math.floor((elapsedMs / SYNCED_LOADER_DURATION_MS) * DOT_COUNT) % DOT_COUNT;
}

// Drive the head with a low-rate timer instead of a per-frame withTiming/
// withRepeat. With no active animation Reanimated idles between ticks and the
// compositor stops producing frames; the old infinite loop pinned the display
// at its refresh rate for the app's whole life, even after every loader left.
function startSharedStepLoop(): void {
  if (sharedStepTimer !== null) {
    return;
  }
  sharedStepProgress.value = currentSnakeStep();
  sharedStepTimer = setInterval(() => {
    sharedStepProgress.value = currentSnakeStep();
  }, SYNCED_LOADER_STEP_MS);
}

function stopSharedStepLoop(): void {
  if (sharedStepTimer !== null) {
    clearInterval(sharedStepTimer);
    sharedStepTimer = null;
  }
}

// Reference-count mounted loaders so the timer runs only while at least one
// working indicator is on screen; the last unmount stops it and lets the UI
// thread go idle.
function acquireSharedStepLoop(): void {
  mountedLoaderCount += 1;
  if (mountedLoaderCount === 1) {
    startSharedStepLoop();
  }
}

function releaseSharedStepLoop(): void {
  mountedLoaderCount = Math.max(0, mountedLoaderCount - 1);
  if (mountedLoaderCount === 0) {
    stopSharedStepLoop();
  }
}

export function SyncedLoader({ size = 10, color }: { size?: number; color: string }) {
  useEffect(() => {
    acquireSharedStepLoop();
    return () => releaseSharedStepLoop();
  }, []);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: 1,
  }));

  const gap = Math.max(1, Math.round(size * 0.12));
  const dotSize = Math.max(2, Math.floor((size - gap * 2) / 3));
  const gridWidth = dotSize * 2 + gap;
  const gridHeight = dotSize * 3 + gap * 2;

  const gridStyle = useMemo(
    () => [animatedStyle, { width: gridWidth, height: gridHeight }],
    [animatedStyle, gridWidth, gridHeight],
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
      <Animated.View style={gridStyle}>
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
              progress={sharedStepProgress}
              left={columnIndex * (dotSize + gap)}
              top={rowIndex * (dotSize + gap)}
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
