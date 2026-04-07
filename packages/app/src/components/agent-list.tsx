import {
  View,
  Text,
  Pressable,
  Modal,
  RefreshControl,
  FlatList,
  type ListRenderItem,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCallback, useMemo, useState, type ReactElement } from "react";
import { router } from "expo-router";
import { StyleSheet, UnistylesRuntime, useUnistyles } from "react-native-unistyles";
import { formatTimeAgo } from "@/utils/time";
import { shortenPath } from "@/utils/shorten-path";
import { type AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useSessionStore } from "@/stores/session-store";
import { Archive } from "lucide-react-native";
import { prepareWorkspaceTab } from "@/utils/workspace-navigation";

interface AgentListProps {
  agents: AggregatedAgent[];
  showCheckoutInfo?: boolean;
  isRefreshing?: boolean;
  onRefresh?: () => void;
  selectedAgentId?: string;
  onAgentSelect?: () => void;
  listFooterComponent?: ReactElement | null;
  showAttentionIndicator?: boolean;
}

type FlatListItem =
  | { type: "header"; key: string; title: string }
  | { type: "agent"; key: string; agent: AggregatedAgent };

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

function formatStatusLabel(status: AggregatedAgent["status"]): string {
  switch (status) {
    case "initializing":
      return "Starting";
    case "idle":
      return "Idle";
    case "running":
      return "Running";
    case "error":
      return "Error";
    case "closed":
      return "Closed";
    default:
      return status;
  }
}

function SessionBadge({
  label,
  icon,
  tone = "neutral",
}: {
  label: string;
  icon?: ReactElement;
  tone?: "neutral" | "warning" | "danger";
}) {
  return (
    <View
      style={[
        styles.badge,
        tone === "warning" && styles.badgeWarning,
        tone === "danger" && styles.badgeDanger,
      ]}
    >
      {icon}
      <Text
        style={[
          styles.badgeText,
          tone === "warning" && styles.badgeTextWarning,
          tone === "danger" && styles.badgeTextDanger,
        ]}
      >
        {label}
      </Text>
    </View>
  );
}

function SessionRow({
  agent,
  isMobile,
  selectedAgentId,
  showAttentionIndicator,
  onPress,
  onLongPress,
}: {
  agent: AggregatedAgent;
  isMobile: boolean;
  selectedAgentId?: string;
  showAttentionIndicator: boolean;
  onPress: (agent: AggregatedAgent) => void;
  onLongPress: (agent: AggregatedAgent) => void;
}) {
  const { theme } = useUnistyles();
  const timeAgo = formatTimeAgo(agent.lastActivityAt);
  const agentKey = `${agent.serverId}:${agent.id}`;
  const isSelected = selectedAgentId === agentKey;
  const statusLabel = formatStatusLabel(agent.status);
  const projectPath = shortenPath(agent.cwd);

  return (
    <Pressable
      style={({ pressed, hovered }) => [
        styles.row,
        isSelected && styles.rowSelected,
        hovered && styles.rowHovered,
        pressed && styles.rowPressed,
      ]}
      onPress={() => onPress(agent)}
      onLongPress={() => onLongPress(agent)}
      testID={`agent-row-${agent.serverId}-${agent.id}`}
    >
      <View style={styles.rowContent}>
        <View style={styles.rowTitleRow}>
          <Text
            style={[styles.sessionTitle, isSelected && styles.sessionTitleHighlighted]}
            numberOfLines={1}
          >
            {agent.title || "New session"}
          </Text>
          {agent.archivedAt ? (
            <SessionBadge
              label="Archived"
              icon={<Archive size={theme.fontSize.xs} color={theme.colors.foregroundMuted} />}
            />
          ) : null}
          {(agent.pendingPermissionCount ?? 0) > 0 ? (
            <SessionBadge label={`${agent.pendingPermissionCount} pending`} tone="warning" />
          ) : null}
          {!isMobile && showAttentionIndicator && agent.requiresAttention ? (
            <SessionBadge label="Attention" tone="danger" />
          ) : null}
        </View>
        {isMobile && (
          <View style={styles.rowMetaRow}>
            <Text style={styles.sessionMetaText} numberOfLines={1}>
              {projectPath}
            </Text>
            <Text style={styles.sessionMetaSeparator}>·</Text>
            <Text style={styles.sessionMetaText}>{statusLabel}</Text>
            <Text style={styles.sessionMetaSeparator}>·</Text>
            <Text style={styles.sessionMetaText}>{timeAgo}</Text>
            {agent.serverLabel ? (
              <>
                <Text style={styles.sessionMetaSeparator}>·</Text>
                <Text style={styles.sessionMetaText} numberOfLines={1}>
                  {agent.serverLabel}
                </Text>
              </>
            ) : null}
          </View>
        )}
      </View>
      {!isMobile && (
        <>
          <Text style={styles.columnMeta} numberOfLines={1}>
            {projectPath}
          </Text>
          <Text style={styles.columnMetaFixed}>{statusLabel}</Text>
          <Text style={styles.columnMetaFixed}>{timeAgo}</Text>
        </>
      )}
      {isMobile && showAttentionIndicator && agent.requiresAttention ? (
        <View style={styles.rowTrailing}>
          <SessionBadge label="Attention" tone="danger" />
        </View>
      ) : null}
    </Pressable>
  );
}

export function AgentList({
  agents,
  isRefreshing = false,
  onRefresh,
  selectedAgentId,
  onAgentSelect,
  listFooterComponent,
  showAttentionIndicator = true,
}: AgentListProps) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const [actionAgent, setActionAgent] = useState<AggregatedAgent | null>(null);
  const isMobile = UnistylesRuntime.breakpoint === "xs" || UnistylesRuntime.breakpoint === "sm";

  const actionClient = useSessionStore((state) =>
    actionAgent?.serverId ? (state.sessions[actionAgent.serverId]?.client ?? null) : null,
  );

  const isActionSheetVisible = actionAgent !== null;
  const isActionDaemonUnavailable = Boolean(actionAgent?.serverId && !actionClient);

  const handleAgentPress = useCallback(
    (agent: AggregatedAgent) => {
      if (isActionSheetVisible) {
        return;
      }

      const serverId = agent.serverId;
      const agentId = agent.id;

      onAgentSelect?.();

      const route = prepareWorkspaceTab({
        serverId,
        workspaceId: agent.cwd,
        target: { kind: "agent", agentId },
        pin: Boolean(agent.archivedAt),
      });
      router.navigate(route);
    },
    [isActionSheetVisible, onAgentSelect],
  );

  const handleAgentLongPress = useCallback((agent: AggregatedAgent) => {
    setActionAgent(agent);
  }, []);

  const handleCloseActionSheet = useCallback(() => {
    setActionAgent(null);
  }, []);

  const handleArchiveAgent = useCallback(() => {
    if (!actionAgent || !actionClient) {
      return;
    }
    void actionClient.archiveAgent(actionAgent.id);
    setActionAgent(null);
  }, [actionAgent, actionClient]);

  const flatItems = useMemo((): FlatListItem[] => {
    const order = ["Today", "Yesterday", "This week", "This month", "Older"] as const;
    const buckets = new Map<string, AggregatedAgent[]>();
    for (const agent of agents) {
      const label = deriveDateSectionLabel(agent.lastActivityAt);
      const existing = buckets.get(label) ?? [];
      existing.push(agent);
      buckets.set(label, existing);
    }

    const result: FlatListItem[] = [];
    for (const label of order) {
      const data = buckets.get(label);
      if (!data || data.length === 0) {
        continue;
      }
      result.push({ type: "header", key: `header:${label}`, title: label });
      for (const agent of data) {
        result.push({ type: "agent", key: `${agent.serverId}:${agent.id}`, agent });
      }
    }
    return result;
  }, [agents]);

  const renderItem: ListRenderItem<FlatListItem> = useCallback(
    ({ item }) => {
      if (item.type === "header") {
        return (
          <View style={styles.sectionHeading}>
            <Text style={styles.sectionTitle}>{item.title}</Text>
          </View>
        );
      }
      return (
        <SessionRow
          agent={item.agent}
          isMobile={isMobile}
          selectedAgentId={selectedAgentId}
          showAttentionIndicator={showAttentionIndicator}
          onPress={handleAgentPress}
          onLongPress={handleAgentLongPress}
        />
      );
    },
    [handleAgentLongPress, handleAgentPress, isMobile, selectedAgentId, showAttentionIndicator],
  );

  const keyExtractor = useCallback((item: FlatListItem) => item.key, []);

  return (
    <>
      <FlatList
        data={flatItems}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        ListFooterComponent={listFooterComponent}
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

      <Modal
        visible={isActionSheetVisible}
        animationType="fade"
        transparent
        onRequestClose={handleCloseActionSheet}
      >
        <View style={styles.sheetOverlay}>
          <Pressable style={styles.sheetBackdrop} onPress={handleCloseActionSheet} />
          <View
            style={[
              styles.sheetContainer,
              { paddingBottom: Math.max(insets.bottom, theme.spacing[6]) },
            ]}
          >
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>
              {isActionDaemonUnavailable ? "Host offline" : "Archive this session?"}
            </Text>
            <View style={styles.sheetButtonRow}>
              <Pressable
                style={[styles.sheetButton, styles.sheetCancelButton]}
                onPress={handleCloseActionSheet}
                testID="agent-action-cancel"
              >
                <Text style={styles.sheetCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                disabled={isActionDaemonUnavailable}
                style={[styles.sheetButton, styles.sheetArchiveButton]}
                onPress={handleArchiveAgent}
                testID="agent-action-archive"
              >
                <Text
                  style={[
                    styles.sheetArchiveText,
                    isActionDaemonUnavailable && styles.sheetArchiveTextDisabled,
                  ]}
                >
                  Archive
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    flex: 1,
    minHeight: 0,
  },
  listContent: {
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[6],
    },
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[6],
    gap: theme.spacing[1],
  },
  sectionHeading: {
    marginTop: theme.spacing[2],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    marginBottom: theme.spacing[2],
  },
  sectionTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: {
      xs: theme.borderRadius.lg,
      md: 0,
    },
    marginBottom: {
      xs: theme.spacing[1],
      md: 0,
    },
  },
  rowContent: {
    flex: 1,
    minWidth: 0,
  },
  rowTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  rowMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1],
    marginTop: 2,
  },
  rowTrailing: {
    marginLeft: theme.spacing[2],
  },
  rowSelected: {
    backgroundColor: theme.colors.surface2,
  },
  rowHovered: {
    backgroundColor: theme.colors.surface1,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  sessionTitle: {
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    fontWeight: "400",
    color: theme.colors.foreground,
    opacity: 0.86,
  },
  sessionTitleHighlighted: {
    opacity: 1,
  },
  sessionMetaText: {
    maxWidth: "100%",
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  sessionMetaSeparator: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    opacity: 0.7,
  },
  columnMeta: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
    minWidth: 60,
    maxWidth: 200,
    marginLeft: theme.spacing[4],
  },
  columnMetaFixed: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    flexShrink: 0,
    width: 72,
    textAlign: "right" as const,
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
  },
  badgeWarning: {
    backgroundColor: "rgba(245, 158, 11, 0.12)",
  },
  badgeDanger: {
    backgroundColor: "rgba(239, 68, 68, 0.14)",
  },
  badgeText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  badgeTextWarning: {
    color: theme.colors.palette.amber[500],
  },
  badgeTextDanger: {
    color: theme.colors.palette.red[300],
  },
  sheetOverlay: {
    flex: 1,
    justifyContent: "flex-end",
  },
  sheetBackdrop: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  sheetContainer: {
    backgroundColor: theme.colors.surface2,
    borderTopLeftRadius: theme.borderRadius["2xl"],
    borderTopRightRadius: theme.borderRadius["2xl"],
    paddingHorizontal: theme.spacing[6],
    paddingTop: theme.spacing[4],
    gap: theme.spacing[4],
  },
  sheetHandle: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundMuted,
    opacity: 0.3,
  },
  sheetTitle: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    textAlign: "center",
  },
  sheetButtonRow: {
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  sheetButton: {
    flex: 1,
    borderRadius: theme.borderRadius.lg,
    paddingVertical: theme.spacing[4],
    alignItems: "center",
    justifyContent: "center",
  },
  sheetArchiveButton: {
    backgroundColor: theme.colors.primary,
  },
  sheetArchiveText: {
    color: theme.colors.primaryForeground,
    fontWeight: theme.fontWeight.semibold,
    fontSize: theme.fontSize.base,
  },
  sheetArchiveTextDisabled: {
    opacity: 0.5,
  },
  sheetCancelButton: {
    backgroundColor: theme.colors.surface1,
  },
  sheetCancelText: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.semibold,
    fontSize: theme.fontSize.base,
  },
}));
