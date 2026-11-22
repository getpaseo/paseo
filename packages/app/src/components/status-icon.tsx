import { useMemo, type ReactElement, type ReactNode } from "react";
import { View } from "react-native";
import { CircleAlert } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import type { SurfaceBackdrop } from "@/styles/surface-backdrop";
import { getStatusDotColor } from "@/utils/status-dot-color";
import { StatusRing } from "@/components/status-ring";
import { getStatusRingOffset } from "@/components/status-ring/geometry";
import {
  STATUS_INDICATOR_ALERT_SIZE,
  STATUS_INDICATOR_DOT_SIZE,
} from "@/utils/status-indicator-geometry";
import type { Theme } from "@/styles/theme";

interface StatusIconProps {
  children: ReactNode;
  statusBucket: SidebarStateBucket | null;
  size?: number;
  statusDotBorderColor?: string;
  backdrop: SurfaceBackdrop;
}
const DEFAULT_STATUS_DOT_OFFSET = -2;
const STATUS_ALERT_OFFSET = -3;
const ThemedCircleAlert = withUnistyles(CircleAlert);
const needsInputAlertMapping = (theme: Theme) => ({
  color: theme.colors.surface0,
  fill: getStatusDotColor({ theme, bucket: "needs_input" }) ?? undefined,
});

export function StatusIcon({
  children,
  statusBucket,
  size = 14,
  statusDotBorderColor,
  backdrop,
}: StatusIconProps): ReactElement {
  const bucket = statusBucket;
  const isRunning = bucket === "running";
  const showDot = bucket === "failed" || bucket === "attention" || bucket === "needs_follow_up";
  const showNeedsInputAlert = bucket === "needs_input";
  const agentIconWrapperStyle = useMemo(
    () => [styles.agentIconWrapper, { width: size, height: size }],
    [size],
  );

  return (
    <View style={agentIconWrapperStyle}>
      {children}
      {isRunning ? (
        <View
          style={styles.statusRing}
          accessibilityRole="progressbar"
          accessibilityLabel="Agent running"
        >
          <StatusRing backdrop={backdrop} />
        </View>
      ) : null}
      {showDot ? (
        <View
          testID="agent-status-dot"
          style={styles.statusDot(bucket, backdrop, statusDotBorderColor)}
        />
      ) : null}
      {showNeedsInputAlert ? (
        <View style={styles.statusAlertOverlay}>
          <ThemedCircleAlert size={STATUS_INDICATOR_ALERT_SIZE} uniProps={needsInputAlertMapping} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  agentIconWrapper: {
    position: "relative",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  statusDot: (bucket: SidebarStateBucket, backdrop: SurfaceBackdrop, borderColor?: string) => ({
    position: "absolute",
    right: DEFAULT_STATUS_DOT_OFFSET,
    bottom: DEFAULT_STATUS_DOT_OFFSET,
    width: STATUS_INDICATOR_DOT_SIZE,
    height: STATUS_INDICATOR_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    backgroundColor: getStatusDotColor({ theme, bucket }) ?? undefined,
    borderColor: borderColor ?? theme.colors[backdrop],
  }),
  statusRing: {
    position: "absolute",
    right: getStatusRingOffset(DEFAULT_STATUS_DOT_OFFSET, STATUS_INDICATOR_DOT_SIZE),
    bottom: getStatusRingOffset(DEFAULT_STATUS_DOT_OFFSET, STATUS_INDICATOR_DOT_SIZE),
  },
  statusAlertOverlay: {
    position: "absolute",
    right: STATUS_ALERT_OFFSET,
    bottom: STATUS_ALERT_OFFSET,
  },
}));
