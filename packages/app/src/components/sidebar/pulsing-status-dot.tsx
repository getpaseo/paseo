import { useEffect } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  makeMutable,
  useAnimatedStyle,
  useReducedMotion,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { useRetainedPanelActive } from "@/components/retained-panel";

// The busy affordance for a sidebar row. Every status in the sidebar is a dot; busy is the
// one that moves. Callers own the dot's geometry and color and pass it in as a style — this
// module owns nothing but the pulse.
//
// Opacity only, and shallow: the dot sits in a column of static dots in neighboring rows, so
// anything that changes its size or drops it near invisible reads as jitter down the list.
// One full cycle is out-and-back, so the visible period is twice the half period.
const PULSE_HALF_PERIOD_MS = 900;
const PULSE_MIN_OPACITY = 0.65;

// One clock for every pulsing dot in the app. Dots that each start their own animation drift
// apart as rows mount at different times, and a column of them fading out of step is noise —
// the same reason SyncedLoader drives all its instances from a single step. The value *is*
// the opacity, so subscribers read it directly and there is nothing per-instance to fall out
// of phase.
//
// Refcounted so the animation only runs while at least one dot is mounted: an unattended
// withRepeat keeps the UI thread's frame loop awake forever.
const pulseClock = makeMutable(1);
let pulseClockSubscribers = 0;

function acquirePulseClock(): void {
  pulseClockSubscribers += 1;
  if (pulseClockSubscribers > 1) {
    return;
  }
  pulseClock.value = withRepeat(
    withTiming(PULSE_MIN_OPACITY, {
      duration: PULSE_HALF_PERIOD_MS,
      easing: Easing.inOut(Easing.quad),
    }),
    -1,
    true,
  );
}

function releasePulseClock(): void {
  pulseClockSubscribers -= 1;
  if (pulseClockSubscribers > 0) {
    return;
  }
  cancelAnimation(pulseClock);
  pulseClock.value = 1;
}

/** A status dot, breathing in step with every other one on screen. */
export function PulsingStatusDot({
  style,
  testID,
}: {
  style: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const active = useRetainedPanelActive();
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (!active || reduceMotion) {
      return;
    }
    acquirePulseClock();
    return releasePulseClock;
  }, [active, reduceMotion]);

  const pulseStyle = useAnimatedStyle(() => ({ opacity: pulseClock.value }));

  // Reduced motion leaves the dot fully opaque. It still carries the running color, and the
  // status is spelled out in the surrounding row's accessible label either way.
  return <Animated.View testID={testID} style={[style, reduceMotion ? null : pulseStyle]} />;
}
