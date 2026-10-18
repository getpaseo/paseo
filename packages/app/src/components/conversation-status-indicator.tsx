import { useLayoutEffect } from "react";
import { View } from "react-native";
import Animated, {
  makeMutable,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
} from "react-native-reanimated";
import { scheduleOnUI } from "react-native-worklets";
import { StyleSheet } from "react-native-unistyles";

const INDICATOR_SIZE = 14;
const GRID_DOT_SIZE = 3.5;
const GRID_GAP = 1.25;
const GRID_PERIOD = 1500;
const PULSE_PERIOD = 2000;
const animationTime = makeMutable(Date.now());
const activeIndicatorCount = makeMutable(0);
const clockRunning = makeMutable(false);

function advanceClock(): void {
  "worklet";
  if (activeIndicatorCount.value === 0) {
    clockRunning.value = false;
    return;
  }
  animationTime.value = Date.now();
  requestAnimationFrame(advanceClock);
}

function registerIndicator(registered: SharedValue<boolean>): void {
  "worklet";
  if (registered.value) return;
  registered.value = true;
  activeIndicatorCount.value += 1;
  if (!clockRunning.value) {
    clockRunning.value = true;
    animationTime.value = Date.now();
    requestAnimationFrame(advanceClock);
  }
}

function unregisterIndicator(registered: SharedValue<boolean>): void {
  "worklet";
  if (!registered.value) return;
  registered.value = false;
  activeIndicatorCount.value -= 1;
}

function useAnimationTime(animate: boolean): SharedValue<number> {
  const registered = useSharedValue(false);
  useLayoutEffect(() => {
    if (!animate) return;
    scheduleOnUI(registerIndicator, registered);
    return () => scheduleOnUI(unregisterIndicator, registered);
  }, [animate, registered]);
  return animationTime;
}

export type ConversationStatusIndicatorKind = "activity" | "attention" | "needs_input";

/** Shared 14px sidebar mark for active work and unread conversation states. */
export function ConversationStatusIndicator({
  kind,
  testID,
}: {
  kind: ConversationStatusIndicatorKind;
  testID?: string;
}) {
  const reduceMotion = useReducedMotion();
  const time = useAnimationTime(!reduceMotion);
  const colorStyle = getColorStyle(kind);

  return (
    <View accessible={false} style={styles.frame} testID={testID} importantForAccessibility="no">
      {kind === "activity" ? (
        <View style={styles.grid}>
          {Array.from({ length: 9 }, (_, index) => (
            <GridCell
              key={index}
              index={index}
              colorStyle={colorStyle}
              time={time}
              reduceMotion={reduceMotion}
            />
          ))}
        </View>
      ) : (
        <>
          <PulseRing offset={0} kind={kind} time={time} reduceMotion={reduceMotion} />
          <PulseRing offset={1000} kind={kind} time={time} reduceMotion={reduceMotion} />
          <PulseCenter colorStyle={colorStyle} time={time} reduceMotion={reduceMotion} />
        </>
      )}
    </View>
  );
}

function GridCell({
  index,
  colorStyle,
  time,
  reduceMotion,
}: {
  index: number;
  colorStyle: typeof styles.activityColor;
  time: SharedValue<number>;
  reduceMotion: boolean;
}) {
  const animatedStyle = useAnimatedStyle(() => {
    if (reduceMotion) return { opacity: 0.8 };
    const phase =
      (((time.value % GRID_PERIOD) + index * (GRID_PERIOD / 9)) % GRID_PERIOD) / GRID_PERIOD;
    return { opacity: 0.3 + 0.7 * (0.5 + 0.5 * Math.cos(phase * Math.PI * 2)) };
  }, [index, reduceMotion]);
  const left = (index % 3) * (GRID_DOT_SIZE + GRID_GAP);
  const top = Math.floor(index / 3) * (GRID_DOT_SIZE + GRID_GAP);
  return (
    <Animated.View
      style={[
        styles.gridCell,
        colorStyle,
        { left, top, opacity: reduceMotion ? 0.8 : undefined },
        animatedStyle,
      ]}
    />
  );
}

function PulseRing({
  offset,
  kind,
  time,
  reduceMotion,
}: {
  offset: number;
  kind: ConversationStatusIndicatorKind;
  time: SharedValue<number>;
  reduceMotion: boolean;
}) {
  const animatedStyle = useAnimatedStyle(() => {
    if (reduceMotion) return { opacity: 0.7, transform: [{ scale: 0.86 }] };
    const phase = ((time.value - offset + PULSE_PERIOD) % PULSE_PERIOD) / PULSE_PERIOD;
    return { opacity: 0.85 * (1 - phase), transform: [{ scale: 0.35 + phase * 0.7 }] };
  }, [offset, reduceMotion]);
  const ringColorStyle = getRingColorStyle(kind);
  return <Animated.View style={[styles.pulseRing, ringColorStyle, animatedStyle]} />;
}

function PulseCenter({
  colorStyle,
  time,
  reduceMotion,
}: {
  colorStyle: typeof styles.activityColor;
  time: SharedValue<number>;
  reduceMotion: boolean;
}) {
  const animatedStyle = useAnimatedStyle(() => {
    if (reduceMotion) return { transform: [{ scale: 1 }] };
    const phase = (time.value % 1000) / 1000;
    return { transform: [{ scale: 0.78 + 0.22 * (0.5 + 0.5 * Math.cos(phase * Math.PI * 2)) }] };
  }, [reduceMotion]);
  return <Animated.View style={[styles.pulseCenter, colorStyle, animatedStyle]} />;
}

const styles = StyleSheet.create((theme) => ({
  frame: {
    width: INDICATOR_SIZE,
    height: INDICATOR_SIZE,
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  grid: { width: 13, height: 13, position: "relative" },
  gridCell: {
    width: GRID_DOT_SIZE,
    height: GRID_DOT_SIZE,
    borderRadius: 0.8,
    position: "absolute",
  },
  pulseRing: {
    width: INDICATOR_SIZE,
    height: INDICATOR_SIZE,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1.25,
    position: "absolute",
  },
  pulseCenter: {
    width: 4,
    height: 4,
    borderRadius: theme.borderRadius.full,
  },
  activityColor: { backgroundColor: theme.colors.statusIndicatorActivity },
  attentionColor: { backgroundColor: theme.colors.statusDotSuccess },
  needsInputColor: { backgroundColor: theme.colors.statusIndicatorNeedsInput },
  activityRingColor: { borderColor: theme.colors.statusIndicatorActivity },
  attentionRingColor: { borderColor: theme.colors.statusDotSuccess },
  needsInputRingColor: { borderColor: theme.colors.statusIndicatorNeedsInput },
}));

function getColorStyle(kind: ConversationStatusIndicatorKind) {
  switch (kind) {
    case "activity":
      return styles.activityColor;
    case "attention":
      return styles.attentionColor;
    case "needs_input":
      return styles.needsInputColor;
  }
}

function getRingColorStyle(kind: ConversationStatusIndicatorKind) {
  switch (kind) {
    case "activity":
      return styles.activityRingColor;
    case "attention":
      return styles.attentionRingColor;
    case "needs_input":
      return styles.needsInputRingColor;
  }
}
