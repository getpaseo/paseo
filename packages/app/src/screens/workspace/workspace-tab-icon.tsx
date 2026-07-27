import { useMemo, type ReactElement } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SyncedLoader } from "@/components/synced-loader";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { isEmphasizedStatusDotBucket } from "@/utils/status-dot-color";
import { shouldRenderSyncedStatusLoader } from "@/utils/status-loader";

export interface WorkspaceTabPresentation {
  key: string;
  kind: WorkspaceTabDescriptor["kind"];
  label: string;
  subtitle: string;
  tooltip: string;
  modified: boolean;
  titleState: "ready" | "loading";
  icon: React.ComponentType<{ size: number; color: string }>;
  statusBucket: SidebarStateBucket | null;
}

const DEFAULT_STATUS_DOT_SIZE = 7;
const EMPHASIZED_STATUS_DOT_SIZE = 9;
const DEFAULT_STATUS_DOT_OFFSET = 0;
const EMPHASIZED_STATUS_DOT_OFFSET = -1;

interface WorkspaceTabIconProps {
  presentation: WorkspaceTabPresentation;
  active?: boolean;
  size?: number;
  statusDotBorderColor?: string;
}

export function WorkspaceTabIcon({
  presentation,
  active = false,
  size = 14,
  statusDotBorderColor,
}: WorkspaceTabIconProps): ReactElement {
  const iconColor = active ? styles.iconActive.color : styles.iconInactive.color;
  const bucket = presentation.statusBucket;
  let statusDotColor: string | null = null;
  if (bucket === "needs_input") statusDotColor = styles.statusDotNeedsInput.color;
  else if (bucket === "failed") statusDotColor = styles.statusDotFailed.color;
  else if (bucket === "running") statusDotColor = styles.statusDotRunning.color;
  else if (bucket === "attention") statusDotColor = styles.statusDotAttention.color;
  const statusDotSize = isEmphasizedStatusDotBucket(presentation.statusBucket)
    ? EMPHASIZED_STATUS_DOT_SIZE
    : DEFAULT_STATUS_DOT_SIZE;
  const statusDotOffset =
    statusDotSize === EMPHASIZED_STATUS_DOT_SIZE
      ? EMPHASIZED_STATUS_DOT_OFFSET
      : DEFAULT_STATUS_DOT_OFFSET;
  const shouldShowLoader = shouldRenderSyncedStatusLoader({
    bucket: presentation.statusBucket,
  });
  const Icon = presentation.icon;
  const agentIconWrapperStyle = useMemo(
    () => [styles.agentIconWrapper, { width: size, height: size }],
    [size],
  );
  const statusDotStyle = useMemo(
    () => [
      styles.statusDot,
      {
        backgroundColor: statusDotColor ?? undefined,
        borderColor: statusDotBorderColor ?? styles.statusDotBorderDefault.borderColor,
        width: statusDotSize,
        height: statusDotSize,
        right: statusDotOffset,
        bottom: statusDotOffset,
      },
    ],
    [statusDotColor, statusDotBorderColor, statusDotSize, statusDotOffset],
  );

  if (shouldShowLoader) {
    return (
      <View style={agentIconWrapperStyle}>
        <SyncedLoader size={size - 1} color={styles.syncedLoader.color} />
      </View>
    );
  }

  return (
    <View style={agentIconWrapperStyle}>
      <Icon size={size} color={iconColor} />
      {statusDotColor ? <View style={statusDotStyle} /> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  agentIconWrapper: {
    position: "relative",
    alignItems: "center",
    justifyContent: "center",
  },
  statusDot: {
    position: "absolute",
    right: DEFAULT_STATUS_DOT_OFFSET,
    bottom: DEFAULT_STATUS_DOT_OFFSET,
    width: DEFAULT_STATUS_DOT_SIZE,
    height: DEFAULT_STATUS_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
  },
  statusDotBorderDefault: {
    borderColor: theme.colors.surface0,
  },
  statusDotNeedsInput: {
    color: theme.colors.palette.amber[500],
  },
  statusDotFailed: {
    color: theme.colors.palette.red[500],
  },
  statusDotRunning: {
    color: theme.colors.palette.blue[500],
  },
  statusDotAttention: {
    color: theme.colors.palette.green[500],
  },
  iconActive: {
    color: theme.colors.foreground,
  },
  iconInactive: {
    color: theme.colors.foregroundMuted,
  },
  syncedLoader: {
    color:
      theme.colorScheme === "light"
        ? theme.colors.palette.amber[700]
        : theme.colors.palette.amber[500],
  },
}));
