import { type ReactNode, useMemo } from "react";
import { StyleSheet as RNStyleSheet, View } from "react-native";
import {
  useStatusPulseAnimationRef,
  useStatusRingAnimationRef,
  useStatusToneAnimationRef,
} from "@/components/status-ring/clock.web";
import { STATUS_RING_SIZE } from "@/components/status-ring/geometry";
import type { StatusPulseProps } from "./motion";

/**
 * Web motion for the running mark. A sidebar full of agents can hold dozens of these at once, so
 * the browser drives every one of them from one absolute document-timeline epoch rather than from
 * mount time, and only transform and opacity move, which the compositor animates without the main
 * thread — see `clock.web.ts`.
 */
export function StatusRingRotator({ children }: { children: ReactNode }) {
  const rotatorRef = useStatusRingAnimationRef();

  return (
    <View ref={rotatorRef} style={motionStyles.rotator}>
      {children}
    </View>
  );
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
  const carrierRef = useStatusPulseAnimationRef();
  const toneRef = useStatusToneAnimationRef();
  const boxStyle = useMemo(() => ({ width: size, height: size }), [size]);

  return (
    <View ref={carrierRef} style={boxStyle}>
      {running}
      <View ref={toneRef} style={motionStyles.tone}>
        {success}
      </View>
    </View>
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
