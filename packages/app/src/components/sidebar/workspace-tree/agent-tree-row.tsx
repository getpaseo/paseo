import { memo, useCallback, useMemo } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useSidebarTreeExpansionStore } from "@/stores/sidebar-tree-expansion-store";
import type { AgentTreeNode } from "./agent-tree";
import { buildAgentRowPresentation, resolveTreeAgentLabel } from "./row-presentation";
import { WorkspaceTreeRow } from "./tree-row";

interface AgentTreeRowProps {
  node: AgentTreeNode;
  depth: number;
  serverId: string;
  workspaceId: string;
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
  onWorkspacePress,
}: AgentTreeRowProps) {
  const { t } = useTranslation();

  const agentKey = agentExpansionKey(serverId, node.agent.id);
  const expanded = useSidebarTreeExpansionStore((state) => state.expandedAgentKeys.has(agentKey));
  const toggleAgentExpanded = useSidebarTreeExpansionStore((state) => state.toggleAgentExpanded);

  const hasChildren = node.children.length > 0;
  const isProvider = node.agent.kind === "provider";
  const label = resolveTreeAgentLabel(node.agent.title, t("workspace.tabs.loading"));

  const handleNavigate = useCallback(() => {
    onWorkspacePress?.();
    if (isProvider) {
      navigateToWorkspace({
        serverId,
        workspaceId,
        target: {
          kind: "provider_subagent",
          parentAgentId: node.agent.parentAgentId ?? "",
          subagentId: node.agent.id,
        },
      });
    } else {
      navigateToWorkspace({
        serverId,
        workspaceId,
        target: { kind: "agent", agentId: node.agent.id },
      });
    }
  }, [
    isProvider,
    onWorkspacePress,
    serverId,
    workspaceId,
    node.agent.id,
    node.agent.parentAgentId,
  ]);

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
              onWorkspacePress={onWorkspacePress}
            />
          ))
        : null}
    </View>
  );
});
