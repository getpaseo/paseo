import { memo, useMemo } from "react";
import { Animated, View } from "react-native";
import {
  StatusRingFrame,
  type StatusRingProps,
  rotatorStyles,
  styles,
} from "@/components/status-ring/frame";
import { useStatusRingRotation } from "@/components/status-ring/clock";

/**
 * Native running indicator. The rotation runs on the native animation driver from a shared
 * wall-clock phase, so a ring that mounts mid-flight is already in phase — see `clock.ts`.
 *
 * The rotated view carries no theme-tracked style; the coloured arc is nested inside it. Putting
 * a Unistyles style on an animated view crashes on theme change (docs/unistyles.md).
 */
export const StatusRing = memo(function StatusRing({ backdrop }: StatusRingProps) {
  const rotation = useStatusRingRotation();
  const rotatorStyle = useMemo(() => ({ transform: [{ rotate: rotation }] }), [rotation]);

  return (
    <StatusRingFrame backdrop={backdrop}>
      <Animated.View style={[rotatorStyles.rotator, rotatorStyle]}>
        <View style={styles.arc} />
      </Animated.View>
    </StatusRingFrame>
  );
});
