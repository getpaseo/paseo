import { memo, useCallback, useMemo, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useSidebarTreeExpansionStore } from "@/stores/sidebar-tree-expansion-store";
import type { Theme } from "@/styles/theme";
import { collectPaseoAgentIds } from "./agent-tree";
import { useActiveTreeTab } from "./use-active-tree-tab";
import { useHydrateProviderSubagents } from "./use-hydrate-provider-subagents";
import { useWorkspaceAgentTree } from "./use-workspace-agent-tree";
import { useSidebarWorkspaceTerminals } from "./use-sidebar-workspace-terminals";
import { TREE_CHEVRON_SLOT_WIDTH } from "./tree-layout";
import { WorkspaceTreeNode } from "./workspace-tree-node";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);

const chevronColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface SidebarWorkspaceTreeItemProps {
  workspaceKey: string;
  serverId: string;
  workspaceId: string;
  workspaceDirectory: string | null | undefined;
  onWorkspacePress?: () => void;
  /** The rendered workspace row (drag handle and all). */
  children: ReactNode;
}

/**
 * Wraps a sidebar workspace row with a leading expand/collapse chevron and,
 * when expanded, the agent/terminal subtree.
 *
 * The chevron column is always *reserved*, on every workspace row, so titles
 * share one left edge whether or not a workspace can expand. The chevron itself
 * is only drawn when there is something to show, so an empty workspace is not
 * expandable and never opens onto a blank subtree.
 *
 * Agents come from the session store, so they cost nothing. Terminals are read
 * from the shared query cache, and probed once when the answer is not yet known
 * (see `useSidebarWorkspaceTerminals`) — replica queries never expire, so that
 * is at most one request per workspace per session and the chevron is accurate
 * for terminal-only workspaces too.
 */
export const SidebarWorkspaceTreeItem = memo(function SidebarWorkspaceTreeItem({
  workspaceKey,
  serverId,
  workspaceId,
  workspaceDirectory,
  onWorkspacePress,
  children,
}: SidebarWorkspaceTreeItemProps) {
  const { t } = useTranslation();

  const expanded = useSidebarTreeExpansionStore((state) =>
    state.expandedWorkspaceKeys.has(workspaceKey),
  );
  const toggleWorkspaceExpanded = useSidebarTreeExpansionStore(
    (state) => state.toggleWorkspaceExpanded,
  );

  const agentTree = useWorkspaceAgentTree({ serverId, workspaceId });
  const { terminals } = useSidebarWorkspaceTerminals({
    serverId,
    workspaceId,
    workspaceDirectory,
    expanded,
  });
  const activeTab = useActiveTreeTab(serverId);
  const hasContent = agentTree.length > 0 || terminals.length > 0;

  // Pre-existing provider subagents live only in the daemon's list until asked
  // for; live ones push themselves in. Hydrate on expand so both show up.
  const paseoAgentIds = useMemo(() => collectPaseoAgentIds(agentTree), [agentTree]);
  useHydrateProviderSubagents({ serverId, agentIds: paseoAgentIds, enabled: expanded });

  const handleToggle = useCallback(() => {
    toggleWorkspaceExpanded(workspaceKey);
  }, [toggleWorkspaceExpanded, workspaceKey]);

  return (
    <View>
      <View style={styles.row}>
        {hasContent ? (
          <Pressable
            onPress={handleToggle}
            accessibilityRole="button"
            accessibilityLabel={
              expanded ? t("sidebar.tree.collapseWorkspace") : t("sidebar.tree.expandWorkspace")
            }
            style={styles.chevronSlot}
            hitSlop={8}
          >
            {expanded ? (
              <ThemedChevronDown size={14} uniProps={chevronColorMapping} />
            ) : (
              <ThemedChevronRight size={14} uniProps={chevronColorMapping} />
            )}
          </Pressable>
        ) : (
          // Reserved but empty, so an empty workspace's title stays in column.
          <View style={styles.chevronSlot} />
        )}
        <View style={styles.rowContent}>{children}</View>
      </View>
      {expanded && hasContent ? (
        <WorkspaceTreeNode
          agentTree={agentTree}
          terminals={terminals}
          serverId={serverId}
          workspaceId={workspaceId}
          activeTab={activeTab}
          onWorkspacePress={onWorkspacePress}
        />
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create(() => ({
  row: {
    flexDirection: "row",
    alignItems: "stretch",
  },
  chevronSlot: {
    width: TREE_CHEVRON_SLOT_WIDTH,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  rowContent: {
    flex: 1,
    minWidth: 0,
  },
}));
