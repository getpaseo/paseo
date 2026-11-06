import { useCallback, useLayoutEffect, useMemo, useRef, type RefCallback } from "react";
import { View, type View as NativeView } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { useRetainedPanelActive } from "@/components/retained-panel";
import {
  SYNCED_LOADER_FADE_IN_MS,
  SYNCED_LOADER_FADE_OUT_MS,
  SYNCED_LOADER_HOLD_MS,
  SYNCED_LOADER_PEAK_OPACITY,
  SYNCED_LOADER_PERIOD_MS,
  SYNCED_LOADER_STILL_ELAPSED_MS,
  type SyncedLoaderDotFrame,
  getSyncedLoaderDotDelay,
  getSyncedLoaderDotFrames,
  getSyncedLoaderDotOpacity,
} from "@/components/synced-loader-state";

// The same waveform as `getSyncedLoaderDotOpacity`, as keyframes. The sine fade in and the cosine
// fade out are the easeOutSine and easeInSine curves.
const EASE_OUT_SINE = "cubic-bezier(0.61, 1, 0.88, 1)";
const EASE_IN_SINE = "cubic-bezier(0.12, 0, 0.39, 0)";
const FADE_IN_END = SYNCED_LOADER_FADE_IN_MS / SYNCED_LOADER_PERIOD_MS;
const HOLD_END = (SYNCED_LOADER_FADE_IN_MS + SYNCED_LOADER_HOLD_MS) / SYNCED_LOADER_PERIOD_MS;
const PULSE_END =
  (SYNCED_LOADER_FADE_IN_MS + SYNCED_LOADER_HOLD_MS + SYNCED_LOADER_FADE_OUT_MS) /
  SYNCED_LOADER_PERIOD_MS;
const DOT_KEYFRAMES: Keyframe[] = [
  { offset: 0, opacity: 0, easing: EASE_OUT_SINE },
  { offset: FADE_IN_END, opacity: SYNCED_LOADER_PEAK_OPACITY },
  { offset: HOLD_END, opacity: SYNCED_LOADER_PEAK_OPACITY, easing: EASE_IN_SINE },
  { offset: PULSE_END, opacity: 0 },
  { offset: 1, opacity: 0 },
];
// Every animation starts at the document timeline origin, not at mount, so all loaders on the
// page stay in phase. See `status-ring/clock.web.ts`.
const TIMELINE_START_MS = 0;

/**
 * Web running loader. The browser runs one animation per dot, so a page with many loaders does
 * not write styles from JavaScript on every frame. Native has its own implementation in
 * `synced-loader.tsx`.
 */
export function SyncedLoader({ size = 10, color }: { size?: number; color: string }) {
  const active = useRetainedPanelActive();
  const reduceMotion = useReducedMotion();
  const animate = active && !reduceMotion;
  const frames = useMemo(() => getSyncedLoaderDotFrames(size), [size]);
  const containerStyle = useMemo(() => ({ width: size, height: size }), [size]);

  return (
    <View style={containerStyle}>
      {frames.map((frame, dot) => (
        <LoaderDot key={frame.key} dot={dot} frame={frame} color={color} animate={animate} />
      ))}
    </View>
  );
}

function LoaderDot({
  dot,
  frame,
  color,
  animate,
}: {
  dot: number;
  frame: SyncedLoaderDotFrame;
  color: string;
  animate: boolean;
}) {
  const ref = useDotAnimationRef(dot, animate);
  // The still frame is the inline opacity. A running animation overrides it.
  const dotStyle = useMemo(
    () => ({
      position: "absolute" as const,
      left: frame.left,
      top: frame.top,
      width: frame.size,
      height: frame.size,
      borderRadius: frame.size / 2,
      backgroundColor: color,
      opacity: getSyncedLoaderDotOpacity(SYNCED_LOADER_STILL_ELAPSED_MS, dot),
    }),
    [color, dot, frame],
  );

  return <View ref={ref} style={dotStyle} />;
}

function useDotAnimationRef(dot: number, animate: boolean): RefCallback<NativeView> {
  const element = useRef<HTMLElement | null>(null);
  const setElement = useCallback((instance: NativeView | null) => {
    element.current = instance instanceof HTMLElement ? instance : null;
  }, []);

  useLayoutEffect(() => {
    const target = element.current;
    if (!animate || !target) {
      return;
    }

    const animation = target.animate(DOT_KEYFRAMES, {
      duration: SYNCED_LOADER_PERIOD_MS,
      delay: getSyncedLoaderDotDelay(dot),
      iterations: Number.POSITIVE_INFINITY,
    });
    animation.startTime = TIMELINE_START_MS;
    return () => {
      animation.cancel();
    };
  }, [animate, dot]);

  return setElement;
}
