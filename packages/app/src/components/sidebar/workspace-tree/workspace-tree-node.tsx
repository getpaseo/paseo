import { memo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { AgentTreeNode } from "./agent-tree";
import { AgentTreeRow } from "./agent-tree-row";
import { TerminalTreeRow } from "./terminal-tree-row";

interface WorkspaceTreeNodeProps {
  agentTree: AgentTreeNode[];
  terminals: { id: string; name: string; title?: string | null }[];
  terminalsLoading: boolean;
  serverId: string;
  workspaceId: string;
  onWorkspacePress?: () => void;
}

export const WorkspaceTreeNode = memo(function WorkspaceTreeNode({
  agentTree,
  terminals,
  terminalsLoading,
  serverId,
  workspaceId,
  onWorkspacePress,
}: WorkspaceTreeNodeProps) {
  const { t } = useTranslation();

  const hasAgents = agentTree.length > 0;
  const hasTerminals = terminals.length > 0;

  let content: ReactNode;
  if (!hasAgents && !hasTerminals) {
    content = (
      <Text style={styles.emptyState}>
        {terminalsLoading ? t("sidebar.tree.loading") : t("sidebar.tree.empty")}
      </Text>
    );
  } else {
    content = (
      <View>
        {agentTree.map((node) => (
          <AgentTreeRow
            key={node.agent.id}
            node={node}
            depth={0}
            serverId={serverId}
            workspaceId={workspaceId}
            onWorkspacePress={onWorkspacePress}
          />
        ))}
        {hasTerminals
          ? terminals.map((terminal) => (
              <TerminalTreeRow
                key={terminal.id}
                terminalId={terminal.id}
                name={terminal.name}
                title={terminal.title ?? null}
                serverId={serverId}
                workspaceId={workspaceId}
                onWorkspacePress={onWorkspacePress}
              />
            ))
          : null}
      </View>
    );
  }

  return <View style={styles.subtree}>{content}</View>;
});

const styles = StyleSheet.create((theme) => ({
  subtree: {
    paddingLeft: 20,
    paddingVertical: theme.spacing[1],
  },
  emptyState: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    paddingLeft: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    opacity: 0.7,
  },
}));
