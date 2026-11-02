import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { DiffStat } from "@/components/diff-stat";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { useAppSettings } from "@/hooks/use-settings";
import type { SidebarWorkspaceTrailing } from "@/hooks/use-settings";
import { useCompactTimeAgo } from "@/hooks/use-time-ago";
import type { WorkspaceAgentStatusCounts } from "@/utils/workspace-agent-activity";

export type { SidebarWorkspaceTrailing };

const EMPTY_AGENT_STATUS_COUNTS: WorkspaceAgentStatusCounts = { unread: 0, running: 0, read: 0 };

/**
 * The slot to the right of a workspace title. Three renderers behind one preference, so
 * every row renderer asks the same question and the kebab overlay geometry stays identical
 * no matter which one is showing.
 *
 * "none" exists because the slot is the only thing competing with the title for width, and
 * a user who never reads the diff would rather have the characters.
 */
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
  if (trailing === "diff") return workspace.diffStat !== null;
  if (trailing === "timestamp") return workspace.statusEnteredAt !== null;
  return trailing === "agentStatus";
}

export function SidebarWorkspaceTrailingContent({
  workspace,
  trailing,
}: {
  workspace: SidebarWorkspaceEntry;
  trailing: SidebarWorkspaceTrailing;
}) {
  if (trailing === "diff" && workspace.diffStat) {
    return (
      <DiffStat additions={workspace.diffStat.additions} deletions={workspace.diffStat.deletions} />
    );
  }
  if (trailing === "timestamp" && workspace.statusEnteredAt) {
    return <WorkspaceTimestamp enteredAt={workspace.statusEnteredAt} />;
  }
  if (trailing === "agentStatus") {
    return (
      <SidebarAgentStatusCounts counts={workspace.agentStatusCounts ?? EMPTY_AGENT_STATUS_COUNTS} />
    );
  }
  return null;
}

export function SidebarAgentStatusCounts({
  counts,
  testID = "sidebar-workspace-agent-status-counts",
}: {
  counts: WorkspaceAgentStatusCounts;
  testID?: string;
}) {
  const { t } = useTranslation();
  // Nothing to report: the slot stays empty rather than spending width on zeroes.
  if (counts.unread === 0 && counts.running === 0 && counts.read === 0) {
    return null;
  }
  return (
    <View
      style={styles.agentStatusCounts}
      testID={testID}
      accessibilityLabel={t("sidebar.display.show.agentStatusCounts", {
        ...counts,
        defaultValue: "{{unread}} unread, {{running}} running, {{read}} read",
      })}
    >
      {/* Fixed-width slots: a missing number leaves a gap in place, so the three columns stay
          on the same x for every row instead of sliding with the title length. */}
      <View style={styles.agentStatusSlot}>
        {counts.unread > 0 ? (
          <Text style={[styles.agentStatusValue, styles.agentStatusUnread]}>{counts.unread}</Text>
        ) : null}
      </View>
      <View style={styles.agentStatusSlot}>
        {counts.running > 0 ? (
          <Text style={[styles.agentStatusValue, styles.agentStatusRunning]}>{counts.running}</Text>
        ) : null}
      </View>
      <View style={styles.agentStatusSlot}>
        {counts.read > 0 ? (
          <Text style={[styles.agentStatusValue, styles.agentStatusRead]}>{counts.read}</Text>
        ) : null}
      </View>
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
  agentStatusCounts: {
    height: 20,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  agentStatusSlot: {
    width: 22,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
  },
  agentStatusValue: {
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    textAlign: "right",
    fontVariant: ["tabular-nums"],
  },
  // Green: finished, not opened. Blue: running. Grey: opened already.
  agentStatusUnread: { color: theme.colors.statusDotSuccess },
  agentStatusRunning: { color: theme.colors.statusDotRunning },
  agentStatusRead: { color: theme.colors.foregroundMuted },
}));
