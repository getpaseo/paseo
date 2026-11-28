import { memo } from "react";
import { ActivityIndicator } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import {
  StatusRingFrame,
  type StatusRingProps,
  rotatorStyles,
} from "@/components/status-ring/frame";
import { STATUS_RING_SIZE } from "@/components/status-ring/geometry";
import type { Theme } from "@/styles/theme";
import { getStatusDotColor } from "@/utils/status-dot-color";

export function getAndroidRunningIndicatorProps(theme: Theme) {
  return {
    color: getStatusDotColor({ theme, bucket: "running" }) ?? undefined,
  };
}

const RunningIndicator = withUnistyles(ActivityIndicator, getAndroidRunningIndicatorProps);

// Reanimated's per-frame ShadowTree commits can starve a concurrent Unistyles resize commit.
// Android's platform drawable animates without committing a new ShadowTree each frame.
export const StatusRing = memo(function StatusRing({ backdrop }: StatusRingProps) {
  return (
    <StatusRingFrame backdrop={backdrop}>
      <RunningIndicator size={STATUS_RING_SIZE} style={rotatorStyles.rotator} />
    </StatusRingFrame>
  );
});
