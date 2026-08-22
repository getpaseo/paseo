import { memo } from "react";
import { View } from "react-native";
import {
  StatusRingFrame,
  type StatusRingProps,
  rotatorStyles,
  styles,
} from "@/components/status-ring/frame";
import { useStatusRingAnimationRef } from "@/components/status-ring/clock.web";
import { useRetainedPanelActive } from "@/components/retained-panel";

/**
 * Web running indicator. A sidebar full of agents can hold dozens of these at once, so the browser
 * drives the rotation from one absolute document-timeline epoch rather than from mount time — see
 * `clock.web.ts`.
 */
export const StatusRing = memo(function StatusRing({ backdrop }: StatusRingProps) {
  const active = useRetainedPanelActive();
  const rotatorRef = useStatusRingAnimationRef(active);

  return (
    <StatusRingFrame backdrop={backdrop}>
      <View ref={rotatorRef} style={rotatorStyles.rotator}>
        <View style={styles.arc} />
      </View>
    </StatusRingFrame>
  );
});
