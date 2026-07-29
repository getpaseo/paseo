import { memo, useCallback, useMemo } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useSidebarTreeExpansionStore } from "@/stores/sidebar-tree-expansion-store";
import { buildDeterministicWorkspaceTabId } from "@/workspace-tabs/identity";
import type { AgentTreeNode } from "./agent-tree";
import {
  buildAgentRowPresentation,
  buildAgentRowTarget,
  resolveRowWorkspaceId,
  resolveTreeAgentLabel,
} from "./row-presentation";
import type { ActiveTreeTab } from "./use-active-tree-tab";
import { WorkspaceTreeRow } from "./tree-row";

interface AgentTreeRowProps {
  node: AgentTreeNode;
  depth: number;
  serverId: string;
  /** The workspace whose subtree this row is displayed under. */
  workspaceId: string;
  /** The tab currently being viewed on this server, or null. */
  activeTab: ActiveTreeTab | null;
  onWorkspacePress?: () => void;
}

function agentExpansionKey(serverId: string, agentId: string): string {
  return `${serverId}:${agentId}`;
}

export const AgentTreeRow = memo(function AgentTreeRow({
  node,
  depth,
  serverId,
  workspaceId,
  activeTab,
  onWorkspacePress,
}: AgentTreeRowProps) {
  const { t } = useTranslation();

  const agentKey = agentExpansionKey(serverId, node.agent.id);
  const expanded = useSidebarTreeExpansionStore((state) => state.expandedAgentKeys.has(agentKey));
  const toggleAgentExpanded = useSidebarTreeExpansionStore((state) => state.toggleAgentExpanded);

  const hasChildren = node.children.length > 0;
  const label = resolveTreeAgentLabel(node.agent.title, t("workspace.tabs.loading"));

  // One target drives both navigation and the active-row check.
  const target = useMemo(() => buildAgentRowTarget(node.agent), [node.agent]);
  // A cross-workspace subagent is displayed here but belongs elsewhere, so its
  // own workspace decides where it opens and where it counts as active.
  const rowWorkspaceId = resolveRowWorkspaceId(node.agent, workspaceId);
  const selected =
    activeTab !== null &&
    activeTab.workspaceId === rowWorkspaceId &&
    activeTab.tabId === buildDeterministicWorkspaceTabId(target);

  const handleNavigate = useCallback(() => {
    onWorkspacePress?.();
    navigateToWorkspace({ serverId, workspaceId: rowWorkspaceId, target });
  }, [onWorkspacePress, serverId, rowWorkspaceId, target]);

  const handleToggle = useCallback(() => {
    toggleAgentExpanded(agentKey);
  }, [agentKey, toggleAgentExpanded]);

  const presentation = useMemo(
    () => buildAgentRowPresentation(node.agent, label),
    [label, node.agent],
  );

  let toggleAccessibilityLabel: string | undefined;
  if (hasChildren) {
    toggleAccessibilityLabel = expanded
      ? t("sidebar.tree.collapseAgent", { label })
      : t("sidebar.tree.expandAgent", { label });
  }

  return (
    <View>
      <WorkspaceTreeRow
        depth={depth}
        presentation={presentation}
        label={label}
        onPress={handleNavigate}
        selected={selected}
        onToggle={hasChildren ? handleToggle : undefined}
        expanded={expanded}
        toggleAccessibilityLabel={toggleAccessibilityLabel}
      />
      {expanded && hasChildren
        ? node.children.map((child) => (
            <AgentTreeRow
              key={child.agent.id}
              node={child}
              depth={depth + 1}
              serverId={serverId}
              workspaceId={workspaceId}
              activeTab={activeTab}
              onWorkspacePress={onWorkspacePress}
            />
          ))
        : null}
    </View>
  );
});
