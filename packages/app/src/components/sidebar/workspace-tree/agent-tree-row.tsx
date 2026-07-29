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
  resolveTreeAgentLabel,
} from "./row-presentation";
import { WorkspaceTreeRow } from "./tree-row";

interface AgentTreeRowProps {
  node: AgentTreeNode;
  depth: number;
  serverId: string;
  workspaceId: string;
  /** Tab id currently being viewed in this workspace, or null. */
  activeTabId: string | null;
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
  activeTabId,
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
  const selected = activeTabId !== null && buildDeterministicWorkspaceTabId(target) === activeTabId;

  const handleNavigate = useCallback(() => {
    onWorkspacePress?.();
    navigateToWorkspace({ serverId, workspaceId, target });
  }, [onWorkspacePress, serverId, workspaceId, target]);

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
              activeTabId={activeTabId}
              onWorkspacePress={onWorkspacePress}
            />
          ))
        : null}
    </View>
  );
});
