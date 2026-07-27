import { memo, useCallback, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useSidebarTreeExpansionStore } from "@/stores/sidebar-tree-expansion-store";
import type { Theme } from "@/styles/theme";
import { useWorkspaceAgentTree } from "./use-workspace-agent-tree";
import { useSidebarWorkspaceTerminals } from "./use-sidebar-workspace-terminals";
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
 * when expanded, the agent/terminal subtree. The chevron only appears when the
 * workspace has agents or terminals to show — empty workspaces are not
 * expandable.
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
  const agentTree = useWorkspaceAgentTree({ serverId, workspaceId });
  const { terminals, isLoading: terminalsLoading } = useSidebarWorkspaceTerminals({
    serverId,
    workspaceId,
    workspaceDirectory,
    enabled: true,
  });

  const hasContent = agentTree.length > 0 || terminals.length > 0 || terminalsLoading;

  const expanded = useSidebarTreeExpansionStore((state) =>
    state.expandedWorkspaceKeys.has(workspaceKey),
  );
  const toggleWorkspaceExpanded = useSidebarTreeExpansionStore(
    (state) => state.toggleWorkspaceExpanded,
  );

  const handleToggle = useCallback(() => {
    toggleWorkspaceExpanded(workspaceKey);
  }, [toggleWorkspaceExpanded, workspaceKey]);

  if (!hasContent) {
    return <View style={styles.rowContent}>{children}</View>;
  }

  return (
    <View>
      <View style={styles.row}>
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
        <View style={styles.rowContent}>{children}</View>
      </View>
      {expanded ? (
        <WorkspaceTreeNode
          agentTree={agentTree}
          terminals={terminals}
          terminalsLoading={terminalsLoading}
          serverId={serverId}
          workspaceId={workspaceId}
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
    width: 20,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  rowContent: {
    flex: 1,
    minWidth: 0,
  },
}));
