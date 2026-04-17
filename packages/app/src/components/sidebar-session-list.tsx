import { useCallback, useMemo } from "react";
import { FlatList, Pressable, RefreshControl, Text, View, type ListRenderItem } from "react-native";
import { router } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { MessagesSquare } from "lucide-react-native";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { formatTimeAgo } from "@/utils/time";
import { prepareWorkspaceTab } from "@/utils/workspace-navigation";

function deriveDateSectionLabel(lastActivityAt: Date): string {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
  const activityStart = new Date(
    lastActivityAt.getFullYear(),
    lastActivityAt.getMonth(),
    lastActivityAt.getDate(),
  );

  if (activityStart.getTime() >= todayStart.getTime()) {
    return "Today";
  }
  if (activityStart.getTime() >= yesterdayStart.getTime()) {
    return "Yesterday";
  }

  const diffTime = todayStart.getTime() - activityStart.getTime();
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
  if (diffDays <= 7) {
    return "This week";
  }
  if (diffDays <= 30) {
    return "This month";
  }
  return "Older";
}

function basename(cwd: string): string {
  if (!cwd) return "";
  const trimmed = cwd.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

type SidebarSessionListItem =
  | { type: "header"; key: string; title: string }
  | { type: "agent"; key: string; agent: AggregatedAgent };

interface SidebarSessionListProps {
  agents: AggregatedAgent[];
  isRefreshing?: boolean;
  onRefresh?: () => void;
  selectedAgentId?: string;
  onAgentPress?: () => void;
}

export function SidebarSessionList({
  agents,
  isRefreshing = false,
  onRefresh,
  selectedAgentId,
  onAgentPress,
}: SidebarSessionListProps) {
  const { theme } = useUnistyles();

  const items = useMemo((): SidebarSessionListItem[] => {
    const order = ["Today", "Yesterday", "This week", "This month", "Older"] as const;
    const buckets = new Map<string, AggregatedAgent[]>();
    for (const agent of agents) {
      const label = deriveDateSectionLabel(agent.lastActivityAt);
      const existing = buckets.get(label) ?? [];
      existing.push(agent);
      buckets.set(label, existing);
    }
    const result: SidebarSessionListItem[] = [];
    for (const label of order) {
      const data = buckets.get(label);
      if (!data || data.length === 0) continue;
      result.push({ type: "header", key: `header:${label}`, title: label });
      for (const agent of data) {
        result.push({ type: "agent", key: `${agent.serverId}:${agent.id}`, agent });
      }
    }
    return result;
  }, [agents]);

  const handleAgentPress = useCallback(
    (agent: AggregatedAgent) => {
      onAgentPress?.();
      const route = prepareWorkspaceTab({
        serverId: agent.serverId,
        workspaceId: agent.cwd,
        target: { kind: "agent", agentId: agent.id },
        pin: Boolean(agent.archivedAt),
      });
      router.navigate(route);
    },
    [onAgentPress],
  );

  const renderItem: ListRenderItem<SidebarSessionListItem> = useCallback(
    ({ item }) => {
      if (item.type === "header") {
        return (
          <View style={styles.sectionHeading}>
            <Text style={styles.sectionTitle}>{item.title}</Text>
          </View>
        );
      }
      const agent = item.agent;
      const key = `${agent.serverId}:${agent.id}`;
      const isActive = selectedAgentId === key;
      const project = basename(agent.cwd);
      const timeAgo = formatTimeAgo(agent.lastActivityAt);
      return (
        <Pressable
          onPress={() => handleAgentPress(agent)}
          testID={`sidebar-session-row-${agent.serverId}-${agent.id}`}
          style={({ hovered, pressed }) => [
            styles.row,
            hovered && styles.rowHovered,
            pressed && styles.rowPressed,
            isActive && styles.rowActive,
          ]}
        >
          <View style={styles.titleRow}>
            <Text style={[styles.title, isActive && styles.titleActive]} numberOfLines={1}>
              {agent.title || "New session"}
            </Text>
            {agent.requiresAttention ? <View style={styles.attentionDot} /> : null}
          </View>
          <View style={styles.metaRow}>
            {project ? (
              <Text style={styles.metaText} numberOfLines={1}>
                {project}
              </Text>
            ) : null}
            {project ? <Text style={styles.metaSeparator}>·</Text> : null}
            <Text style={styles.metaTime}>{timeAgo}</Text>
          </View>
        </Pressable>
      );
    },
    [handleAgentPress, selectedAgentId],
  );

  const keyExtractor = useCallback((item: SidebarSessionListItem) => item.key, []);

  if (agents.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <MessagesSquare size={24} color={theme.colors.foregroundMuted} />
        <Text style={styles.emptyText}>No sessions yet</Text>
      </View>
    );
  }

  return (
    <FlatList
      data={items}
      style={styles.list}
      contentContainerStyle={styles.listContent}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        onRefresh ? (
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={onRefresh}
            tintColor={theme.colors.foregroundMuted}
            colors={[theme.colors.foregroundMuted]}
          />
        ) : undefined
      }
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    flex: 1,
    minHeight: 0,
  },
  listContent: {
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[4],
  },
  sectionHeading: {
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[1],
  },
  sectionTitle: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  row: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    gap: 2,
  },
  rowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  rowPressed: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  rowActive: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  title: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    opacity: 0.86,
  },
  titleActive: {
    opacity: 1,
    fontWeight: theme.fontWeight.medium,
  },
  attentionDot: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.palette.red[500],
    flexShrink: 0,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  metaText: {
    flexShrink: 1,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  metaSeparator: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    opacity: 0.6,
  },
  metaTime: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    flexShrink: 0,
  },
  emptyContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[6],
  },
  emptyText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
