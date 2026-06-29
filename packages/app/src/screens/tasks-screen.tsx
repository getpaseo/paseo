import { useCallback, useMemo, type ReactElement } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { StyleSheet, useUnistyles, withUnistyles } from "react-native-unistyles";
import { getProviderIcon } from "@/components/provider-icons";
import { AgentStatusDot } from "@/components/agent-status-dot";
import { MenuHeader } from "@/components/headers/menu-header";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useAggregatedAgents, type AggregatedAgent } from "@/hooks/use-aggregated-agents";
import type { Theme } from "@/styles/theme";
import { navigateToAgent } from "@/utils/navigate-to-agent";

interface TaskRowAgent extends AggregatedAgent {
  taskProgress: NonNullable<AggregatedAgent["taskProgress"]>;
}

function hasActiveTasks(agent: AggregatedAgent): agent is TaskRowAgent {
  return Boolean(agent.taskProgress && agent.taskProgress.total > 0);
}

export function TasksScreen(): ReactElement {
  const isFocused = useIsFocused();
  if (!isFocused) {
    return <View style={styles.container} />;
  }
  return <TasksScreenContent />;
}

function TasksScreenContent(): ReactElement {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const { agents, isInitialLoad } = useAggregatedAgents();

  const taskAgents = useMemo(() => {
    // Running agents first, then most task activity. useAggregatedAgents already
    // sorts running-first by recency, so just filter to those with task lists.
    return agents.filter(hasActiveTasks);
  }, [agents]);

  const renderItem = useCallback(
    ({ item }: { item: TaskRowAgent }) => <TaskAgentRow agent={item} />,
    [],
  );

  const keyExtractor = useCallback((item: TaskRowAgent) => `${item.serverId}:${item.id}`, []);

  function renderBody(): ReactElement {
    if (isInitialLoad) {
      return (
        <View style={styles.centerState}>
          <LoadingSpinner size="large" color={theme.colors.foregroundMuted} />
        </View>
      );
    }
    if (taskAgents.length === 0) {
      return (
        <View style={styles.centerState}>
          <Text style={styles.emptyText}>{t("taskProgress.empty")}</Text>
          <Text style={styles.emptyHint}>{t("taskProgress.emptyHint")}</Text>
        </View>
      );
    }
    return (
      <FlatList
        data={taskAgents}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        contentContainerStyle={styles.listContent}
      />
    );
  }

  return (
    <View style={styles.container}>
      <MenuHeader title={t("taskProgress.dashboardTitle")} />
      {renderBody()}
    </View>
  );
}

function rowPressableStyle({ pressed }: { pressed: boolean }) {
  return [styles.row, pressed && styles.rowPressed];
}

function ProgressFill({ ratio }: { ratio: number }): ReactElement {
  const fillStyle = useMemo(
    () => [styles.progressFill, { width: `${ratio * 100}%` as const }],
    [ratio],
  );
  return <View style={fillStyle} />;
}

function TaskAgentRow({ agent }: { agent: TaskRowAgent }): ReactElement {
  const { serverId, id, taskProgress } = agent;
  const Icon = useMemo(() => withUnistyles(getProviderIcon(agent.provider)), [agent.provider]);
  const title = agent.title?.trim() || agent.cwd.split("/").pop() || agent.id.slice(0, 7);
  const { completed, total } = taskProgress;
  const ratio = total > 0 ? Math.max(0, Math.min(1, completed / total)) : 0;

  const handlePress = useCallback(() => {
    navigateToAgent({ serverId, agentId: id, workspaceId: agent.workspaceId });
  }, [agent.workspaceId, id, serverId]);

  return (
    <Pressable
      accessibilityRole="button"
      testID={`tasks-row-${id}`}
      onPress={handlePress}
      style={rowPressableStyle}
    >
      <View style={styles.rowHeader}>
        <Icon size={16} uniProps={iconColorMapping} />
        <Text style={styles.rowTitle} numberOfLines={1}>
          {title}
        </Text>
        <AgentStatusDot
          status={agent.status}
          requiresAttention={agent.requiresAttention}
          attentionReason={agent.attentionReason}
          pendingPermissionCount={agent.pendingPermissionCount}
        />
        <Text style={styles.rowCount}>
          {completed}/{total}
        </Text>
      </View>
      <View style={styles.progressTrack}>
        <ProgressFill ratio={ratio} />
      </View>
    </Pressable>
  );
}

const iconColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  centerState: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[6],
  },
  emptyText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
  },
  emptyHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  listContent: {
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  row: {
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  rowHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  rowTitle: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  rowCount: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  progressTrack: {
    height: 4,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.palette.blue[500],
  },
}));
