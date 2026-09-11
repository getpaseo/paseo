import { useEffect } from "react";
import {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { useRetainedPanelActive } from "@/components/retained-panel";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";

export function useStatusPulse(bucket: SidebarStateBucket | null, enteredAt?: number | null) {
  const opacity = useSharedValue(1);
  const reduceMotion = useReducedMotion();
  const active = useRetainedPanelActive();

  useEffect(() => {
    cancelAnimation(opacity);
    opacity.value = 1;
    const eligible = bucket === "attention" || bucket === "needs_input";
    if (!eligible || !active || reduceMotion || enteredAt == null || !Number.isFinite(enteredAt)) {
      return;
    }
    const remaining = enteredAt + 60_000 - Date.now();
    if (remaining <= 0) return;

    opacity.value = withRepeat(
      withTiming(0.45, { duration: 750, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
    const stop = () => {
      cancelAnimation(opacity);
      opacity.value = 1;
    };
    const timeout = setTimeout(stop, remaining);
    return () => {
      clearTimeout(timeout);
      stop();
    };
  }, [active, bucket, enteredAt, opacity, reduceMotion]);

  return useAnimatedStyle(() => ({ opacity: opacity.value }), [opacity]);
}
