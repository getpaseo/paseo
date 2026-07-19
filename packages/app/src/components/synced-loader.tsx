import { useLayoutEffect, useMemo, useState } from "react";
import { View } from "react-native";
import Animated, {
  makeMutable,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
} from "react-native-reanimated";
import { scheduleOnUI } from "react-native-worklets";
import { useRetainedPanelActive } from "@/components/retained-panel";
import {
  SYNCED_LOADER_DOT_COUNT,
  getSyncedLoaderDotOpacity,
  getSyncedLoaderStep,
} from "@/components/synced-loader-state";

const GRID_COLUMNS = 2;
const DOT_KEYS = Array.from({ length: SYNCED_LOADER_DOT_COUNT }, (_, i) => `dot-${i}`);
const sharedStep = makeMutable(0);
const activeLoaderCount = makeMutable(0);
const clockRunning = makeMutable(false);
let nextStepListenerId = 1;

function advanceSharedStep(): void {
  "worklet";
  if (activeLoaderCount.value === 0) {
    clockRunning.value = false;
    return;
  }

  const nextStep = getSyncedLoaderStep(Date.now());
  if (sharedStep.value !== nextStep) {
    sharedStep.value = nextStep;
  }
  requestAnimationFrame(advanceSharedStep);
}

function registerStepListener(
  step: SharedValue<number>,
  registered: SharedValue<boolean>,
  listenerId: number,
): void {
  "worklet";
  if (registered.value) {
    return;
  }

  registered.value = true;
  step.value = getSyncedLoaderStep(Date.now());
  sharedStep.addListener(listenerId, (nextStep) => {
    step.value = nextStep;
  });
  activeLoaderCount.value += 1;

  if (!clockRunning.value) {
    clockRunning.value = true;
    sharedStep.value = step.value;
    requestAnimationFrame(advanceSharedStep);
  }
}

function unregisterStepListener(registered: SharedValue<boolean>, listenerId: number): void {
  "worklet";
  if (!registered.value) {
    return;
  }

  registered.value = false;
  sharedStep.removeListener(listenerId);
  activeLoaderCount.value -= 1;
}

function useSyncedLoaderStep(active: boolean, reduceMotion: boolean): SharedValue<number> {
  // The local value lets retained loaders detach from the app-wide clock without
  // unmounting their animated views or leaving hidden style worklets subscribed.
  const step = useSharedValue(reduceMotion ? 0 : getSyncedLoaderStep(Date.now()));
  const registered = useSharedValue(false);
  const [listenerId] = useState(() => nextStepListenerId++);

  useLayoutEffect(() => {
    if (!active || reduceMotion) {
      return;
    }

    scheduleOnUI(registerStepListener, step, registered, listenerId);
    return () => {
      scheduleOnUI(unregisterStepListener, registered, listenerId);
    };
  }, [active, listenerId, reduceMotion, registered, step]);

  return step;
}

export function SyncedLoader({ size = 10, color }: { size?: number; color: string }) {
  const active = useRetainedPanelActive();
  const reduceMotion = useReducedMotion();
  const step = useSyncedLoaderStep(active, reduceMotion);

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
        {Array.from({ length: SYNCED_LOADER_DOT_COUNT }).map((_, dotIndex) => {
          const rowIndex = Math.floor(dotIndex / GRID_COLUMNS);
          const columnIndex = dotIndex % GRID_COLUMNS;

          return (
            <SpinnerDot
              key={DOT_KEYS[dotIndex]}
              color={color}
              dotSize={dotSize}
              dotIndex={dotIndex}
              step={step}
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
  dotIndex,
  step,
  left,
  top,
}: {
  color: string;
  dotSize: number;
  dotIndex: number;
  step: SharedValue<number>;
  left: number;
  top: number;
}) {
  const animatedStyle = useAnimatedStyle(() => ({
    opacity: getSyncedLoaderDotOpacity(step.value, dotIndex),
  }));

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
