import { memo, useMemo } from "react";
import { View } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import {
  StatusRingFrame,
  type StatusRingProps,
  type StatusRingAppearanceProps,
  statusRingRotatorStyle,
  styles,
} from "@/components/status-ring/frame";
import { useStatusRingRotation } from "@/components/status-ring/clock";
import { statusRingAppearance } from "@/components/status-ring/geometry";

/**
 * Native running indicator. The rotation is published by one shared UI-thread clock rather than
 * per-instance timing, so a ring that mounts mid-flight is already in phase — see `clock.ts`.
 *
 * The rotated view carries no theme-tracked style; the coloured arc is nested inside it. Putting
 * a Unistyles style on a Reanimated view crashes on theme change (docs/unistyles.md).
 */
function AnimatedArc({ dotSize }: { dotSize: number }) {
  const rotation = useStatusRingRotation();
  const frameStyle = useMemo(() => statusRingRotatorStyle(dotSize), [dotSize]);
  const rotatorStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  return (
    <Animated.View style={[frameStyle, rotatorStyle]}>
      <View style={styles.arc} />
    </Animated.View>
  );
}

const ThemedStatusRing = withUnistyles(
  memo(function StatusRingContent({
    backdrop,
    dotSize = 6,
    dotOnly = false,
    animated = true,
  }: StatusRingAppearanceProps) {
    let arc = null;
    if (!dotOnly) {
      arc = animated ? (
        <AnimatedArc dotSize={dotSize} />
      ) : (
        <View style={[styles.arc, styles.staticArc]} />
      );
    }
    return <StatusRingFrame backdrop={backdrop}>{arc}</StatusRingFrame>;
  }),
);

export const StatusRing = memo(function StatusRing(props: StatusRingProps) {
  return <ThemedStatusRing {...props} uniProps={statusRingAppearance} />;
});
