import { useMemo, type ReactElement, type ReactNode } from "react";
import { View } from "react-native";
import { CircleAlert } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import type { SurfaceBackdrop } from "@/styles/surface-backdrop";
import { getStatusDotColor } from "@/utils/status-dot-color";
import { StatusRing } from "@/components/status-ring";
import { STATUS_RING_FRAME_SIZE, getStatusRingOffset } from "@/components/status-ring/geometry";
import { SyncedLoader } from "@/components/synced-loader";
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
  /**
   * The running mark. An agent shows the synced loader, the same mark as its in-flight turn
   * footer. A workspace shows the ring, the same mark as its sidebar row.
   */
  runningIndicator?: "loader" | "ring";
}
const DEFAULT_STATUS_DOT_OFFSET = -2;
const STATUS_ALERT_OFFSET = -3;
// The loader sits inside the ring's knockout frame, inset by the same halo, so both running marks
// cover the same corner of the icon.
const RUNNING_LOADER_HALO_INSET = 1;
const RUNNING_LOADER_SIZE = STATUS_RING_FRAME_SIZE - RUNNING_LOADER_HALO_INSET * 2;
const ThemedCircleAlert = withUnistyles(CircleAlert);
const ThemedSyncedLoader = withUnistyles(SyncedLoader);
const runningLoaderColorMapping = (theme: Theme) => ({
  color: getStatusDotColor({ theme, bucket: "running" }) ?? theme.colors.foreground,
});
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
  runningIndicator = "loader",
}: StatusIconProps): ReactElement {
  const bucket = statusBucket;
  const isRunning = bucket === "running";
  let statusDotColor: string | undefined;
  if (bucket === "failed") statusDotColor = styles.statusDotFailed.color;
  else if (bucket === "attention") statusDotColor = styles.statusDotAttention.color;
  const showNeedsInputAlert = bucket === "needs_input";
  const agentIconWrapperStyle = useMemo(
    () => [styles.agentIconWrapper, { width: size, height: size }],
    [size],
  );
  const statusDotStyle = useMemo(
    () => [
      styles.statusDot,
      {
        backgroundColor: statusDotColor,
        borderColor: statusDotBorderColor ?? styles[backdrop].borderColor,
      },
    ],
    [statusDotColor, statusDotBorderColor, backdrop],
  );

  return (
    <View style={agentIconWrapperStyle}>
      {children}
      {isRunning ? (
        <View
          style={
            runningIndicator === "loader"
              ? [styles.runningIndicator, styles.runningLoaderFrame, styles[backdrop]]
              : styles.runningIndicator
          }
          accessibilityRole="progressbar"
          accessibilityLabel="Agent running"
        >
          {runningIndicator === "loader" ? (
            <ThemedSyncedLoader size={RUNNING_LOADER_SIZE} uniProps={runningLoaderColorMapping} />
          ) : (
            <StatusRing backdrop={backdrop} />
          )}
        </View>
      ) : null}
      {statusDotColor ? <View style={statusDotStyle} /> : null}
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
  statusDot: {
    position: "absolute",
    right: DEFAULT_STATUS_DOT_OFFSET,
    bottom: DEFAULT_STATUS_DOT_OFFSET,
    width: STATUS_INDICATOR_DOT_SIZE,
    height: STATUS_INDICATOR_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
  },
  runningIndicator: {
    position: "absolute",
    right: getStatusRingOffset(DEFAULT_STATUS_DOT_OFFSET, STATUS_INDICATOR_DOT_SIZE),
    bottom: getStatusRingOffset(DEFAULT_STATUS_DOT_OFFSET, STATUS_INDICATOR_DOT_SIZE),
  },
  // A rounded square rather than a disc: the loader is a square grid, and a disc this size would
  // leave its corner dots outside the knockout, on top of the icon.
  runningLoaderFrame: {
    width: STATUS_RING_FRAME_SIZE,
    height: STATUS_RING_FRAME_SIZE,
    borderRadius: theme.borderRadius.base,
    alignItems: "center",
    justifyContent: "center",
  },
  // Each backdrop fills the loader knockout and borders the status dot.
  surface0: { backgroundColor: theme.colors.surface0, borderColor: theme.colors.surface0 },
  surface1: { backgroundColor: theme.colors.surface1, borderColor: theme.colors.surface1 },
  surface2: { backgroundColor: theme.colors.surface2, borderColor: theme.colors.surface2 },
  surfaceSidebar: {
    backgroundColor: theme.colors.surfaceSidebar,
    borderColor: theme.colors.surfaceSidebar,
  },
  surfaceSidebarHover: {
    backgroundColor: theme.colors.surfaceSidebarHover,
    borderColor: theme.colors.surfaceSidebarHover,
  },
  surfaceSidebarSelected: {
    backgroundColor: theme.colors.surfaceSidebarSelected,
    borderColor: theme.colors.surfaceSidebarSelected,
  },
  statusAlertOverlay: {
    position: "absolute",
    right: STATUS_ALERT_OFFSET,
    bottom: STATUS_ALERT_OFFSET,
  },
  statusDotFailed: {
    color: getStatusDotColor({ theme, bucket: "failed" }) ?? undefined,
  },
  statusDotAttention: {
    color: getStatusDotColor({ theme, bucket: "attention" }) ?? undefined,
  },
}));
