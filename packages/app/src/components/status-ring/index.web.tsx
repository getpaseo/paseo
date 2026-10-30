import { memo, useMemo } from "react";
import { View } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import {
  StatusRingFrame,
  type StatusRingProps,
  type StatusRingAppearanceProps,
  statusRingRotatorStyle,
  styles,
} from "@/components/status-ring/frame";
import { useStatusRingAnimationRef } from "@/components/status-ring/clock.web";
import { statusRingAppearance } from "@/components/status-ring/geometry";

/**
 * Web running indicator. A sidebar full of agents can hold dozens of these at once, so the browser
 * drives the rotation from one absolute document-timeline epoch rather than from mount time — see
 * `clock.web.ts`.
 */
function AnimatedArc({ dotSize }: { dotSize: number }) {
  const rotatorRef = useStatusRingAnimationRef();
  const frameStyle = useMemo(() => statusRingRotatorStyle(dotSize), [dotSize]);

  return (
    <View ref={rotatorRef} style={frameStyle}>
      <View style={styles.arc} />
    </View>
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
