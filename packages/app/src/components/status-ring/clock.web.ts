import { useCallback, useLayoutEffect, useRef, type RefCallback } from "react";
import type { View as NativeView } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { STATUS_RING_PERIOD_MS } from "@/components/status-ring/geometry";

const STATUS_RING_KEYFRAMES: PropertyIndexedKeyframes = {
  transform: ["rotate(0deg)", "rotate(360deg)"],
};
const STATUS_RING_TIMING: KeyframeAnimationOptions = {
  duration: STATUS_RING_PERIOD_MS,
  easing: "linear",
  iterations: Number.POSITIVE_INFINITY,
};
const STATUS_RING_TIMELINE_START_MS = 0;

// An infinite rotation makes Chromium produce a compositor frame every vsync for as long as it
// runs, and the window server composites each one, even though nothing else on screen changes.
// So the ring only spins where it can be seen and where the user has not asked for less motion;
// otherwise it holds still and the static arc still reads as "running".
export function useStatusRingAnimationRef(): RefCallback<NativeView> {
  const active = useRetainedPanelActive();
  const reduceMotion = useReducedMotion();
  const arcElement = useRef<HTMLElement | null>(null);
  const setArcElement = useCallback((instance: NativeView | null) => {
    arcElement.current = instance instanceof HTMLElement ? instance : null;
  }, []);

  useLayoutEffect(() => {
    const element = arcElement.current;
    if (!element || !active || reduceMotion) {
      return;
    }

    const animation = element.animate(STATUS_RING_KEYFRAMES, STATUS_RING_TIMING);
    animation.startTime = STATUS_RING_TIMELINE_START_MS;
    return () => {
      animation.cancel();
    };
  }, [active, reduceMotion]);

  return setArcElement;
}
