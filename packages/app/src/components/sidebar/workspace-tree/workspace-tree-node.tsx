import { memo } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { TerminalActivity } from "@getpaseo/protocol/terminal-activity";
import type { AgentTreeNode } from "./agent-tree";
import { AgentTreeRow } from "./agent-tree-row";
import { TerminalTreeRow } from "./terminal-tree-row";
import type { ActiveTreeTab } from "./use-active-tree-tab";
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
  serverId: string;
  workspaceId: string;
  /** The tab currently being viewed on this server, or null. */
  activeTab: ActiveTreeTab | null;
  onWorkspacePress?: () => void;
}

export const WorkspaceTreeNode = memo(function WorkspaceTreeNode({
  agentTree,
  terminals,
  serverId,
  workspaceId,
  activeTab,
  onWorkspacePress,
}: WorkspaceTreeNodeProps) {
  // Top-level agents and terminals are siblings at the same depth, so their
  // icons and titles line up in one column. The caller only renders this when
  // there is something to show, so there is no empty case to handle.
  return (
    <View style={styles.subtree}>
      <View>
        {agentTree.map((node) => (
          <AgentTreeRow
            key={node.agent.id}
            node={node}
            depth={TREE_ROOT_DEPTH}
            serverId={serverId}
            workspaceId={workspaceId}
            activeTab={activeTab}
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
            activeTab={activeTab}
            onWorkspacePress={onWorkspacePress}
          />
        ))}
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  subtree: {
    // Line the subtree's chevron column up under the workspace row's label.
    paddingLeft: TREE_CHEVRON_SLOT_WIDTH,
    paddingBottom: theme.spacing[1],
  },
}));
