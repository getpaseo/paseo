import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { DiffStat } from "@/components/diff-stat";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { useAppSettings } from "@/hooks/use-settings";
import type { SidebarWorkspaceTrailing } from "@/hooks/use-settings";
import { useCompactTimeAgo } from "@/hooks/use-time-ago";

import { isSidebarTrailingItemEnabled } from "./selection";

export type { SidebarWorkspaceTrailing };

/** Read the shared trailing preference so every sidebar row keeps the same overlay geometry. */
export function useSidebarWorkspaceTrailing(): SidebarWorkspaceTrailing {
  const {
    settings: { sidebarWorkspaceTrailing },
  } = useAppSettings();
  return sidebarWorkspaceTrailing;
}

/** Whether the slot has anything to draw for this workspace under the current preference. */
export function hasSidebarWorkspaceTrailing({
  workspace,
  trailing,
}: {
  workspace: SidebarWorkspaceEntry;
  trailing: SidebarWorkspaceTrailing;
}): boolean {
  const showDiff = isSidebarTrailingItemEnabled({ trailing, choice: "diff" });
  const showTimestamp = isSidebarTrailingItemEnabled({ trailing, choice: "timestamp" });
  return (
    (showDiff && workspace.diffStat !== null) ||
    (showTimestamp && workspace.statusEnteredAt !== null)
  );
}

/** Render enabled stats side by side; the timestamp owns its clock subscription. */
export function SidebarWorkspaceTrailingContent({
  workspace,
  trailing,
}: {
  workspace: SidebarWorkspaceEntry;
  trailing: SidebarWorkspaceTrailing;
}) {
  const showDiff = isSidebarTrailingItemEnabled({ trailing, choice: "diff" });
  const showTimestamp = isSidebarTrailingItemEnabled({ trailing, choice: "timestamp" });
  if (!hasSidebarWorkspaceTrailing({ workspace, trailing })) return null;
  return (
    <View style={styles.row}>
      {showDiff && workspace.diffStat ? (
        <DiffStat
          additions={workspace.diffStat.additions}
          deletions={workspace.diffStat.deletions}
          testID="sidebar-workspace-diff-stat"
        />
      ) : null}
      {showTimestamp && workspace.statusEnteredAt ? (
        <WorkspaceTimestamp enteredAt={workspace.statusEnteredAt} />
      ) : null}
    </View>
  );
}

/**
 * Its own component so the clock stops here. `useCompactTimeAgo` holds state, and state
 * re-renders the component that owns it — keeping that component down to a single `<Text>` is
 * what stops a minute tick from reaching the row, the list, or the diff stat next door.
 */
function WorkspaceTimestamp({ enteredAt }: { enteredAt: Date }) {
  const label = useCompactTimeAgo(enteredAt);
  return (
    <Text style={styles.timestamp} numberOfLines={1} testID="sidebar-workspace-timestamp">
      {label}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 0,
  },
  // A step below the project title it shares the row with. The timestamp is the one thing here
  // you never came looking for, so it sits at the bottom of the muted ramp rather than tying
  // with the label naming the group.
  timestamp: {
    height: 20,
    lineHeight: 20,
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    flexShrink: 0,
  },
}));
