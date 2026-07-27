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
import { getSyncedLoaderProgress, getSyncedLoaderPulse } from "@/components/synced-loader-state";

const sharedProgress = makeMutable(0);
const activeLoaderCount = makeMutable(0);
const clockRunning = makeMutable(false);
let nextProgressListenerId = 1;

function advanceSharedProgress(): void {
  "worklet";
  if (activeLoaderCount.value === 0) {
    clockRunning.value = false;
    return;
  }

  sharedProgress.value = getSyncedLoaderProgress(Date.now());
  requestAnimationFrame(advanceSharedProgress);
}

function registerProgressListener(
  progress: SharedValue<number>,
  registered: SharedValue<boolean>,
  listenerId: number,
): void {
  "worklet";
  if (registered.value) {
    return;
  }

  registered.value = true;
  progress.value = getSyncedLoaderProgress(Date.now());
  sharedProgress.addListener(listenerId, (nextProgress) => {
    progress.value = nextProgress;
  });
  activeLoaderCount.value += 1;

  if (!clockRunning.value) {
    clockRunning.value = true;
    sharedProgress.value = progress.value;
    requestAnimationFrame(advanceSharedProgress);
  }
}

function unregisterProgressListener(registered: SharedValue<boolean>, listenerId: number): void {
  "worklet";
  if (!registered.value) {
    return;
  }

  registered.value = false;
  sharedProgress.removeListener(listenerId);
  activeLoaderCount.value -= 1;
}

function useSyncedLoaderProgress(active: boolean, reduceMotion: boolean): SharedValue<number> {
  const progress = useSharedValue(reduceMotion ? 1 : getSyncedLoaderProgress(Date.now()));
  const registered = useSharedValue(false);
  const [listenerId] = useState(() => nextProgressListenerId++);

  useLayoutEffect(() => {
    if (!active || reduceMotion) {
      return;
    }

    scheduleOnUI(registerProgressListener, progress, registered, listenerId);
    return () => {
      scheduleOnUI(unregisterProgressListener, registered, listenerId);
    };
  }, [active, listenerId, progress, reduceMotion, registered]);

  return progress;
}

export function SyncedLoader({ size = 10, color }: { size?: number; color: string }) {
  const active = useRetainedPanelActive();
  const reduceMotion = useReducedMotion();
  const progress = useSyncedLoaderProgress(active, Boolean(reduceMotion));
  const dotSize = Math.max(4, Math.round(size * 0.42));

  const animatedStyle = useAnimatedStyle(() => {
    const pulse = getSyncedLoaderPulse(progress.value);
    return {
      opacity: pulse.opacity,
      transform: [{ scale: pulse.scale }],
    };
  });

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

  const dotStyle = useMemo(
    () => [
      animatedStyle,
      {
        width: dotSize,
        height: dotSize,
        borderRadius: dotSize / 2,
        backgroundColor: color,
      },
    ],
    [animatedStyle, color, dotSize],
  );

  return (
    <View style={containerStyle}>
      <Animated.View style={dotStyle} />
    </View>
  );
}
