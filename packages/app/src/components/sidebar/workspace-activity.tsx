import { useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { WorkspaceActivity } from "@getpaseo/protocol/messages";
import { PluginIconView, parseSerializablePluginIcon } from "@/plugins/icons";
import { getStatusDotColor } from "@/utils/status-dot-color";
import type { Theme } from "@/styles/theme";
import { workspaceActivityLabel } from "@/workspace-status/activities";

const ActivityIcon = withUnistyles(PluginIconView);

export function WorkspaceActivityIcon({
  activity,
  size = 14,
}: {
  activity: WorkspaceActivity;
  size?: number;
}) {
  const icon = useMemo(() => {
    try {
      return parseSerializablePluginIcon("Workspace activity", activity.icon ?? "Activity");
    } catch {
      return "Activity";
    }
  }, [activity.icon]);
  const colors = useMemo(
    () => (theme: Theme) => ({
      color: getStatusDotColor({ theme, bucket: activity.status }) ?? theme.colors.foregroundMuted,
    }),
    [activity.status],
  );
  return <ActivityIcon icon={icon} size={size} uniProps={colors} />;
}

/** Full labels remain available to touch clients and screen readers. */
export function WorkspaceActivitiesLabel({
  activities,
}: {
  activities: readonly WorkspaceActivity[];
}) {
  if (!activities.length) return null;
  const label = activities.map(workspaceActivityLabel).join(" · ");
  return (
    <View
      accessible
      accessibilityLabel={label}
      style={styles.row}
      testID="workspace-plugin-activities"
    >
      <WorkspaceActivityIcon activity={activities[0]} size={12} />
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    minWidth: 0,
    marginTop: theme.spacing[1],
  },
  label: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, flexShrink: 1 },
}));
