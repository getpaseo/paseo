import { memo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { TerminalActivity } from "@getpaseo/protocol/terminal-activity";
import type { AgentTreeNode } from "./agent-tree";
import { AgentTreeRow } from "./agent-tree-row";
import { TerminalTreeRow } from "./terminal-tree-row";
import { TREE_CHEVRON_SLOT_WIDTH, TREE_ROOT_DEPTH } from "./tree-layout";

export interface WorkspaceTreeTerminal {
  id: string;
  name: string;
  title?: string | null;
  activity?: TerminalActivity | null;
}

interface WorkspaceTreeNodeProps {
  agentTree: AgentTreeNode[];
  terminals: WorkspaceTreeTerminal[];
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
    // Top-level agents and terminals are siblings at the same depth, so their
    // icons and titles line up in one column.
    content = (
      <View>
        {agentTree.map((node) => (
          <AgentTreeRow
            key={node.agent.id}
            node={node}
            depth={TREE_ROOT_DEPTH}
            serverId={serverId}
            workspaceId={workspaceId}
            onWorkspacePress={onWorkspacePress}
          />
        ))}
        {terminals.map((terminal) => (
          <TerminalTreeRow
            key={terminal.id}
            terminalId={terminal.id}
            name={terminal.name}
            title={terminal.title ?? null}
            activity={terminal.activity ?? null}
            depth={TREE_ROOT_DEPTH}
            serverId={serverId}
            workspaceId={workspaceId}
            onWorkspacePress={onWorkspacePress}
          />
        ))}
      </View>
    );
  }

  return <View style={styles.subtree}>{content}</View>;
});

const styles = StyleSheet.create((theme) => ({
  subtree: {
    // Line the subtree's chevron column up under the workspace row's label.
    paddingLeft: TREE_CHEVRON_SLOT_WIDTH,
    paddingBottom: theme.spacing[1],
  },
  emptyState: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    paddingLeft: TREE_CHEVRON_SLOT_WIDTH,
    paddingVertical: theme.spacing[1],
  },
}));
