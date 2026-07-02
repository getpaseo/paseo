import { memo, useCallback, useMemo } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import {
  buildSubsessionRows,
  type SubsessionRowModel,
} from "@/components/agent-list-subsession-rows";
import { AgentStatusDot } from "@/components/agent-status-dot";
import { useOpenSubsession, type WorkspaceSubsessionAgent } from "@/subagents";

interface FlattenedLeaf {
  key: string;
  agentId: string;
  model: SubsessionRowModel;
}

function flattenWorkspaceSubsessions(agents: readonly WorkspaceSubsessionAgent[]): FlattenedLeaf[] {
  const leaves: FlattenedLeaf[] = [];
  for (const agent of agents) {
    for (const model of buildSubsessionRows(agent.subsessions)) {
      leaves.push({ key: `${agent.agentId}:${model.sub.id}`, agentId: agent.agentId, model });
    }
  }
  return leaves;
}

export const WorkspaceSubsessionList = memo(function WorkspaceSubsessionList({
  serverId,
  agents,
}: {
  serverId: string;
  agents: readonly WorkspaceSubsessionAgent[];
}) {
  const leaves = useMemo(() => flattenWorkspaceSubsessions(agents), [agents]);
  const openSubsession = useOpenSubsession();
  const handleOpenSubsession = useCallback(
    (agentId: string, subsessionId: string) => {
      openSubsession({ serverId, agentId, subsessionId });
    },
    [openSubsession, serverId],
  );

  if (leaves.length === 0) {
    return null;
  }

  return (
    <View testID={`sidebar-workspace-subsessions-${serverId}`}>
      {leaves.map((leaf) => (
        <WorkspaceSubsessionLeaf
          key={leaf.key}
          serverId={serverId}
          agentId={leaf.agentId}
          model={leaf.model}
          onOpen={handleOpenSubsession}
        />
      ))}
    </View>
  );
});

function WorkspaceSubsessionLeaf({
  serverId,
  agentId,
  model,
  onOpen,
}: {
  serverId: string;
  agentId: string;
  model: SubsessionRowModel;
  onOpen: (agentId: string, subsessionId: string) => void;
}) {
  const { t } = useTranslation();
  const title = model.sub.title ?? t("subagents.fallbackTitle");

  const handlePress = useCallback(() => {
    onOpen(agentId, model.sub.id);
  }, [onOpen, agentId, model.sub.id]);

  const rowStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType) => [
      styles.row,
      (hovered || pressed) && styles.rowActive,
    ],
    [],
  );

  const innerStyle = useMemo(
    () => [styles.inner, { paddingLeft: INDENT_BASE + model.depth * INDENT_PER_LEVEL }],
    [model.depth],
  );

  return (
    <Pressable
      style={rowStyle}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={title}
      testID={`sidebar-workspace-subsession-${serverId}-${agentId}-${model.sub.id}`}
    >
      <View style={innerStyle}>
        <View style={styles.dotSlot}>
          <AgentStatusDot status={model.sub.status} requiresAttention={false} />
        </View>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
      </View>
    </Pressable>
  );
}

const INDENT_BASE = 0;
const INDENT_PER_LEVEL = 14;

const styles = StyleSheet.create((theme) => ({
  row: {
    minHeight: 26,
    borderRadius: theme.borderRadius.lg,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    userSelect: "none",
  },
  rowActive: {
    backgroundColor: theme.colors.surface2,
  },
  inner: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 0,
  },
  dotSlot: {
    width: 8,
    height: 8,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    opacity: 0.76,
    flex: 1,
    minWidth: 0,
  },
}));
