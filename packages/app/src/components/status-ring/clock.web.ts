import { useCallback, useLayoutEffect, useRef, type RefCallback } from "react";
import type { View as NativeView } from "react-native";
import {
  STATUS_PULSE_PERIOD_MS,
  STATUS_RING_PERIOD_MS,
  getStatusPulseProgress,
  getStatusPulseScale,
} from "@/components/status-ring/geometry";

const STATUS_RING_KEYFRAMES: PropertyIndexedKeyframes = {
  transform: ["rotate(0deg)", "rotate(360deg)"],
};
const STATUS_RING_TIMING: KeyframeAnimationOptions = {
  duration: STATUS_RING_PERIOD_MS,
  easing: "linear",
  iterations: Number.POSITIVE_INFINITY,
};

// The pulse is the curve native evaluates every frame, sampled, rather than a CSS easing that only
// resembles it, so both platforms breathe alike. At 24 linear segments the largest gap between the
// samples and the curve is under half a percent of its range.
const STATUS_PULSE_SEGMENTS = 24;
const STATUS_PULSE_SAMPLES = Array.from({ length: STATUS_PULSE_SEGMENTS + 1 }, (_, index) => {
  const offset = index / STATUS_PULSE_SEGMENTS;
  return { offset, progress: getStatusPulseProgress(offset * STATUS_PULSE_PERIOD_MS) };
});
const STATUS_PULSE_SCALE_KEYFRAMES: Keyframe[] = STATUS_PULSE_SAMPLES.map(
  ({ offset, progress }) => ({ offset, transform: `scale(${getStatusPulseScale(progress)})` }),
);
const STATUS_PULSE_TONE_KEYFRAMES: Keyframe[] = STATUS_PULSE_SAMPLES.map(
  ({ offset, progress }) => ({ offset, opacity: progress }),
);
const STATUS_PULSE_TIMING: KeyframeAnimationOptions = {
  duration: STATUS_PULSE_PERIOD_MS,
  easing: "linear",
  iterations: Number.POSITIVE_INFINITY,
};

// Every running-mark animation starts at the same absolute point on the document timeline instead
// of at mount, which is what keeps a mark that appears mid-flight in phase with the ones already
// moving. The browser owns the clock; there are no per-instance timers.
const SHARED_TIMELINE_START_MS = 0;

function useSharedTimelineAnimationRef(
  keyframes: Keyframe[] | PropertyIndexedKeyframes,
  timing: KeyframeAnimationOptions,
): RefCallback<NativeView> {
  const animatedElement = useRef<HTMLElement | null>(null);
  const setAnimatedElement = useCallback((instance: NativeView | null) => {
    animatedElement.current = instance instanceof HTMLElement ? instance : null;
  }, []);

  useLayoutEffect(() => {
    const element = animatedElement.current;
    if (!element) {
      return;
    }

    const animation = element.animate(keyframes, timing);
    animation.startTime = SHARED_TIMELINE_START_MS;
    return () => {
      animation.cancel();
    };
  }, [keyframes, timing]);

  return setAnimatedElement;
}

export function useStatusRingAnimationRef(): RefCallback<NativeView> {
  return useSharedTimelineAnimationRef(STATUS_RING_KEYFRAMES, STATUS_RING_TIMING);
}

export function useStatusPulseAnimationRef(): RefCallback<NativeView> {
  return useSharedTimelineAnimationRef(STATUS_PULSE_SCALE_KEYFRAMES, STATUS_PULSE_TIMING);
}

export function useStatusToneAnimationRef(): RefCallback<NativeView> {
  return useSharedTimelineAnimationRef(STATUS_PULSE_TONE_KEYFRAMES, STATUS_PULSE_TIMING);
}
