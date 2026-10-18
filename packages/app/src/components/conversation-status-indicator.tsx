import { useId, useLayoutEffect } from "react";
import { View } from "react-native";
import Animated, {
  makeMutable,
  type SharedValue,
  useAnimatedStyle,
  useAnimatedProps,
  useReducedMotion,
  useSharedValue,
  createAnimatedComponent,
} from "react-native-reanimated";
import { scheduleOnUI } from "react-native-worklets";
import { StyleSheet } from "react-native-unistyles";
import Svg, {
  Circle,
  Defs,
  FeBlend,
  FeColorMatrix,
  FeGaussianBlur,
  Filter,
  G,
} from "react-native-svg";
import { withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";

const INDICATOR_SIZE = 14;
const GRID_DOT_SIZE = 3.5;
const GRID_GAP = 1.25;
const GRID_PERIOD = 1500;
const GOOEY_PERIOD = 750;
const ThemedSvg = withUnistyles(Svg);
const AnimatedSvgCircle = createAnimatedComponent(Circle);
const animationTime = makeMutable(Date.now());
const activeIndicatorCount = makeMutable(0);
const clockRunning = makeMutable(false);

function gooeyEase(progress: number): number {
  "worklet";
  let parameter = progress;
  for (let iteration = 0; iteration < 6; iteration += 1) {
    const inverse = 1 - parameter;
    const x =
      3 * inverse * inverse * parameter * 0.56 +
      3 * inverse * parameter * parameter * 0.17 +
      parameter * parameter * parameter;
    const derivative =
      3 * inverse * inverse * 0.56 +
      6 * inverse * parameter * (0.17 - 0.56) +
      3 * parameter * parameter * 0.83;
    if (derivative < 0.0001) break;
    parameter = Math.max(0, Math.min(1, parameter - (x - progress) / derivative));
  }
  const inverse = 1 - parameter;
  return (
    3 * inverse * inverse * parameter * 0.52 +
    3 * inverse * parameter * parameter * 0.98 +
    parameter * parameter * parameter
  );
}

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
  const filterId = `conversation-gooey-${useId().replace(/:/g, "")}`;

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
        <GooeyBubbles kind={kind} time={time} reduceMotion={reduceMotion} filterId={filterId} />
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

function GooeyBubbles({
  kind,
  time,
  reduceMotion,
  filterId,
}: {
  kind: ConversationStatusIndicatorKind;
  time: SharedValue<number>;
  reduceMotion: boolean;
  filterId: string;
}) {
  const leadingProps = useAnimatedProps(() => {
    const phase = reduceMotion
      ? 0
      : (((time.value % GOOEY_PERIOD) + GOOEY_PERIOD) % GOOEY_PERIOD) / GOOEY_PERIOD;
    const progress = reduceMotion ? 0 : gooeyEase(phase);
    return { cx: 4 + progress * 5, cy: 12, r: 3 + progress * 5 };
  }, [reduceMotion]);
  const trailingProps = useAnimatedProps(() => {
    const phase = reduceMotion
      ? 0
      : (((time.value % GOOEY_PERIOD) + GOOEY_PERIOD) % GOOEY_PERIOD) / GOOEY_PERIOD;
    const progress = reduceMotion ? 0 : gooeyEase(phase);
    return { cx: 15 + progress * 5, cy: 12, r: 8 - progress * 5 };
  }, [reduceMotion]);
  return (
    <ThemedSvg
      width={INDICATOR_SIZE}
      height={INDICATOR_SIZE}
      viewBox="0 0 24 24"
      uniProps={getSvgFillMapping(kind)}
      accessible={false}
    >
      <Defs>
        <DefsFilter id={filterId} />
      </Defs>
      <G filter={`url(#${filterId})`}>
        <AnimatedSvgCircle cx={4} cy={12} r={3} animatedProps={leadingProps} />
        <AnimatedSvgCircle cx={15} cy={12} r={8} animatedProps={trailingProps} />
      </G>
    </ThemedSvg>
  );
}

function DefsFilter({ id }: { id: string }) {
  return (
    <Filter id={id} x="-100%" y="-100%" width="300%" height="300%">
      <FeGaussianBlur in="SourceGraphic" stdDeviation={1.5} result="blurred" />
      <FeColorMatrix
        in="blurred"
        type="matrix"
        values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 18 -7"
        result="gooey"
      />
      <FeBlend in="SourceGraphic" in2="gooey" />
    </Filter>
  );
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
  activityColor: { backgroundColor: theme.colors.statusIndicatorActivity },
  attentionColor: { backgroundColor: theme.colors.statusDotSuccess },
  needsInputColor: { backgroundColor: theme.colors.statusIndicatorNeedsInput },
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

function getSvgFillMapping(kind: ConversationStatusIndicatorKind) {
  switch (kind) {
    case "activity":
      return (theme: Theme) => ({ fill: theme.colors.statusIndicatorActivity });
    case "attention":
      return (theme: Theme) => ({ fill: theme.colors.statusDotSuccess });
    case "needs_input":
      return (theme: Theme) => ({ fill: theme.colors.statusIndicatorNeedsInput });
  }
}
