import { type ReactElement, type ReactNode, useMemo } from "react";
import { StyleSheet as RNStyleSheet } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useStatusPulseProgress, useStatusRingRotation } from "@/components/status-ring/clock";
import { STATUS_RING_SIZE, getStatusPulseScale } from "@/components/status-ring/geometry";

export interface StatusPulseProps {
  // The box `running` already occupies. The carrier takes exactly that box so the scale grows the
  // mark around its own centre and the layout around it never sees a different size.
  size: number;
  reduceMotion: boolean;
  // The mark twice. First in the running colour, drawn as it always has been; with reduced motion
  // it is all that renders. Then the same mark in the success colour, laid over the first and faded
  // in and out. Opacity over an opaque copy is a straight mix of the two colours, so the colour
  // cycle animates opacity alone and both colours stay in theme-tracked styles.
  children: [running: ReactElement, success: ReactElement];
}

/**
 * Native motion for the running mark. Every view here is driven by the one shared UI-thread clock
 * in `clock.ts`, and every view here carries only plain React Native styles: Unistyles and
 * Reanimated mutating the same native node crashes on theme change (docs/unistyles.md). The
 * coloured views ride inside, one level in, where Reanimated never touches them.
 */
export function StatusRingRotator({ children }: { children: ReactNode }) {
  const rotation = useStatusRingRotation();
  const rotatorStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  return <Animated.View style={[motionStyles.rotator, rotatorStyle]}>{children}</Animated.View>;
}

export function StatusPulse({ size, reduceMotion, children }: StatusPulseProps) {
  if (reduceMotion) {
    return children[0];
  }
  return <PulsingStatus size={size}>{children}</PulsingStatus>;
}

function PulsingStatus({
  size,
  children: [running, success],
}: Omit<StatusPulseProps, "reduceMotion">) {
  const progress = useStatusPulseProgress();
  const carrierStyle = useAnimatedStyle(() => ({
    transform: [{ scale: getStatusPulseScale(progress.value) }],
  }));
  const toneStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
  const boxStyle = useMemo(() => ({ width: size, height: size }), [size]);

  return (
    <Animated.View style={[boxStyle, carrierStyle]}>
      {running}
      <Animated.View style={[motionStyles.tone, toneStyle]}>{success}</Animated.View>
    </Animated.View>
  );
}

const motionStyles = RNStyleSheet.create({
  rotator: {
    position: "absolute",
    width: STATUS_RING_SIZE,
    height: STATUS_RING_SIZE,
  },
  tone: {
    ...RNStyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
  },
});
