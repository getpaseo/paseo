import { useLayoutEffect, useState } from "react";
import { Animated, Easing } from "react-native";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { STATUS_RING_PERIOD_MS } from "@/components/status-ring/geometry";

/**
 * Drives one ring's rotation progress, in turns, on the native animation driver. Publishing a rotation from a
 * UI-thread clock every frame made Reanimated clone and commit the shadow tree, and lay it out,
 * on every frame for as long as any agent was running. The native driver updates the view's
 * transform directly instead.
 *
 * Every ring still shares one wall-clock phase: a ring starts at the current phase and turns one
 * full period from there, so a ring that mounts mid-flight lands in step with the others, and
 * restarting the loop at the same phase is seamless.
 */
export function useStatusRingProgress(): Animated.Value {
  const active = useRetainedPanelActive();
  const [progress] = useState(() => new Animated.Value(0));

  useLayoutEffect(() => {
    // Hidden retained views must not keep a native animation running.
    if (!active) return;
    const phase = (Date.now() % STATUS_RING_PERIOD_MS) / STATUS_RING_PERIOD_MS;
    progress.setValue(phase);
    const loop = Animated.loop(
      Animated.timing(progress, {
        toValue: phase + 1,
        duration: STATUS_RING_PERIOD_MS,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [active, progress]);

  return progress;
}

/** The ring's rotation, in turns of `useStatusRingProgress`. */
export function useStatusRingRotation(): Animated.AnimatedInterpolation<string> {
  const progress = useStatusRingProgress();
  const [rotation] = useState(() =>
    progress.interpolate({ inputRange: [0, 2], outputRange: ["0deg", "720deg"] }),
  );
  return rotation;
}
