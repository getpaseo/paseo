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
  SYNCED_LOADER_STILL_ELAPSED_MS,
  type SyncedLoaderDotFrame,
  getSyncedLoaderDotFrames,
  getSyncedLoaderDotOpacity,
  getSyncedLoaderElapsed,
} from "@/components/synced-loader-state";

// One UI-thread clock drives every loader on screen. It runs only while a loader listens to it.
const sharedElapsed = makeMutable(0);
const activeLoaderCount = makeMutable(0);
const clockRunning = makeMutable(false);
let nextListenerId = 1;

function advanceSharedElapsed(): void {
  "worklet";
  if (activeLoaderCount.value === 0) {
    clockRunning.value = false;
    return;
  }

  sharedElapsed.value = getSyncedLoaderElapsed(Date.now());
  requestAnimationFrame(advanceSharedElapsed);
}

function registerLoader(
  elapsed: SharedValue<number>,
  registered: SharedValue<boolean>,
  listenerId: number,
): void {
  "worklet";
  if (registered.value) {
    return;
  }

  registered.value = true;
  elapsed.value = getSyncedLoaderElapsed(Date.now());
  sharedElapsed.addListener(listenerId, (next) => {
    elapsed.value = next;
  });
  activeLoaderCount.value += 1;

  if (!clockRunning.value) {
    clockRunning.value = true;
    sharedElapsed.value = elapsed.value;
    requestAnimationFrame(advanceSharedElapsed);
  }
}

function unregisterLoader(
  elapsed: SharedValue<number>,
  registered: SharedValue<boolean>,
  listenerId: number,
): void {
  "worklet";
  if (!registered.value) {
    return;
  }

  registered.value = false;
  sharedElapsed.removeListener(listenerId);
  activeLoaderCount.value -= 1;
  elapsed.value = SYNCED_LOADER_STILL_ELAPSED_MS;
}

function useSyncedLoaderElapsed(animate: boolean): SharedValue<number> {
  // Each loader keeps a local value fed by the shared clock. A retained loader can then detach
  // from the clock without unmounting its animated views or leaving hidden style worklets
  // subscribed.
  const elapsed = useSharedValue(
    animate ? getSyncedLoaderElapsed(Date.now()) : SYNCED_LOADER_STILL_ELAPSED_MS,
  );
  const registered = useSharedValue(false);
  const [listenerId] = useState(() => nextListenerId++);

  useLayoutEffect(() => {
    if (!animate) {
      return;
    }

    scheduleOnUI(registerLoader, elapsed, registered, listenerId);
    return () => {
      scheduleOnUI(unregisterLoader, elapsed, registered, listenerId);
    };
  }, [animate, elapsed, listenerId, registered]);

  return elapsed;
}

/** Native running loader. Web has its own implementation in `synced-loader.web.tsx`. */
export function SyncedLoader({ size = 10, color }: { size?: number; color: string }) {
  const active = useRetainedPanelActive();
  const reduceMotion = useReducedMotion();
  const elapsed = useSyncedLoaderElapsed(active && !reduceMotion);
  const frames = useMemo(() => getSyncedLoaderDotFrames(size), [size]);
  const containerStyle = useMemo(() => ({ width: size, height: size }), [size]);

  return (
    <View style={containerStyle}>
      {frames.map((frame, dot) => (
        <LoaderDot key={frame.key} dot={dot} frame={frame} color={color} elapsed={elapsed} />
      ))}
    </View>
  );
}

function LoaderDot({
  dot,
  frame,
  color,
  elapsed,
}: {
  dot: number;
  frame: SyncedLoaderDotFrame;
  color: string;
  elapsed: SharedValue<number>;
}) {
  const animatedStyle = useAnimatedStyle(() => ({
    opacity: getSyncedLoaderDotOpacity(elapsed.value, dot),
  }));
  const dotStyle = useMemo(
    () => [
      animatedStyle,
      {
        position: "absolute" as const,
        left: frame.left,
        top: frame.top,
        width: frame.size,
        height: frame.size,
        borderRadius: frame.size / 2,
        backgroundColor: color,
      },
    ],
    [animatedStyle, color, frame],
  );

  return <Animated.View style={dotStyle} />;
}
