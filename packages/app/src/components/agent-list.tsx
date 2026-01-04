import { View, Text, Pressable, Modal, RefreshControl, type ListRenderItem } from "react-native";
import { FlatList } from "react-native-gesture-handler";
import { useCallback, useMemo, useState } from "react";
import { router, usePathname } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { formatTimeAgo } from "@/utils/time";
import { type AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useSessionStore } from "@/stores/session-store";
import { buildAgentNavigationKey, startNavigationTiming } from "@/utils/navigation-timing";

interface AgentListProps {
  agents: AggregatedAgent[];
  isRefreshing?: boolean;
  onRefresh?: () => void;
  selectedAgentId?: string;
  onAgentSelect?: () => void;
}

export function AgentList({ agents, isRefreshing = false, onRefresh, selectedAgentId, onAgentSelect }: AgentListProps) {
  const { theme } = useUnistyles();
  const pathname = usePathname();
  const [actionAgent, setActionAgent] = useState<AggregatedAgent | null>(null);

  // Sort agents with requires attention at the top, limit to 15 for fast rendering
  const sortedAgents = useMemo(() => {
    return [...agents]
      .sort((a, b) => {
        // Requires attention first
        if (a.requiresAttention && !b.requiresAttention) return -1;
        if (!a.requiresAttention && b.requiresAttention) return 1;
        return 0;
      })
      .slice(0, 15);
  }, [agents]);

  // Get the methods for the specific server
  const methods = useSessionStore((state) =>
    actionAgent?.serverId ? state.sessions[actionAgent.serverId]?.methods : undefined
  );
  const deleteAgent = methods?.deleteAgent;

  const isActionSheetVisible = actionAgent !== null;
  const isActionDaemonUnavailable = Boolean(actionAgent?.serverId && !methods);

  const handleAgentPress = useCallback(
    (serverId: string, agentId: string) => {
      if (isActionSheetVisible) {
        return;
      }

      // Clear attention flag when opening agent
      const session = useSessionStore.getState().sessions[serverId];
      if (session?.ws) {
        session.ws.clearAgentAttention(agentId);
      }

      const navigationKey = buildAgentNavigationKey(serverId, agentId);
      startNavigationTiming(navigationKey, {
        from: "home",
        to: "agent",
        params: { serverId, agentId },
      });

      const shouldReplace = pathname.startsWith("/agent/");
      const navigate = shouldReplace ? router.replace : router.push;

      onAgentSelect?.();

      navigate({
        pathname: "/agent/[serverId]/[agentId]",
        params: {
          serverId,
          agentId,
        },
      });
    },
    [isActionSheetVisible, pathname, onAgentSelect]
  );

  const handleAgentLongPress = useCallback((agent: AggregatedAgent) => {
    setActionAgent(agent);
  }, []);

  const handleCloseActionSheet = useCallback(() => {
    setActionAgent(null);
  }, []);

  const handleDeleteAgent = useCallback(() => {
    if (!actionAgent || !deleteAgent) {
      return;
    }
    deleteAgent(actionAgent.id);
    setActionAgent(null);
  }, [actionAgent, deleteAgent]);

  const renderAgentItem = useCallback<ListRenderItem<AggregatedAgent>>(
    ({ item: agent }) => {
      const timeAgo = formatTimeAgo(agent.lastActivityAt);
      const isRunning = agent.status === "running";
      const agentKey = `${agent.serverId}:${agent.id}`;
      const isSelected = selectedAgentId === agentKey;
      const statusColor = isRunning ? "#3b82f6" : agent.requiresAttention ? "#22c55e" : null;

      return (
        <Pressable
          style={({ pressed, hovered }) => [
            styles.agentItem,
            isSelected && styles.agentItemSelected,
            hovered && styles.agentItemHovered,
            pressed && styles.agentItemPressed,
          ]}
          onPress={() => handleAgentPress(agent.serverId, agent.id)}
          onLongPress={() => handleAgentLongPress(agent)}
        >
          {({ hovered }) => (
          <View style={styles.agentContent}>
            <View style={styles.row}>
              {statusColor && (
                <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
              )}
              <Text
                style={[
                  styles.agentTitle,
                  (isSelected || hovered) && styles.agentTitleHighlighted,
                ]}
                numberOfLines={1}
              >
                {agent.title || "New Agent"}
              </Text>
            </View>

            <Text style={styles.secondaryRow} numberOfLines={1}>
              {agent.cwd.replace(/^\/(?:Users|home)\/[^/]+/, "~")} · {timeAgo}
            </Text>
          </View>
          )}
        </Pressable>
      );
    },
    [handleAgentLongPress, handleAgentPress, selectedAgentId]
  );

  const keyExtractor = useCallback(
    (agent: AggregatedAgent) => `${agent.serverId}:${agent.id}`,
    []
  );

  return (
    <>
      <FlatList
        data={sortedAgents}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        keyExtractor={keyExtractor}
        renderItem={renderAgentItem}
        extraData={selectedAgentId}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={12}
        windowSize={7}
        maxToRenderPerBatch={12}
        updateCellsBatchingPeriod={16}
        removeClippedSubviews={true}
        refreshControl={
          onRefresh ? (
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={onRefresh}
              tintColor={theme.colors.mutedForeground}
              colors={[theme.colors.mutedForeground]}
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
          <View style={styles.sheetContainer}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>
              {actionAgent?.title || "Delete agent"}
            </Text>
            <Text style={styles.sheetSubtitle}>
              {isActionDaemonUnavailable
                ? "This host is offline—actions will be available once it reconnects automatically."
                : "Removing this agent only deletes it from Paseo. Claude/Codex keeps the original project."}
            </Text>
            <Pressable
              disabled={!deleteAgent || isActionDaemonUnavailable}
              style={[styles.sheetButton, styles.sheetDeleteButton]}
              onPress={handleDeleteAgent}
            >
              <Text
                style={[
                  styles.sheetDeleteText,
                  (!deleteAgent || isActionDaemonUnavailable) && styles.sheetDeleteTextDisabled,
                ]}
              >
                {isActionDaemonUnavailable ? "Host offline" : "Delete agent"}
              </Text>
            </Pressable>
            <Pressable
              style={[styles.sheetButton, styles.sheetCancelButton]}
              onPress={handleCloseActionSheet}
            >
              <Text style={styles.sheetCancelText}>Cancel</Text>
            </Pressable>
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
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
  agentItem: {
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    marginBottom: theme.spacing[2],
  },
  agentItemSelected: {
    backgroundColor: theme.colors.palette.zinc[800],
  },
  agentItemHovered: {
    backgroundColor: theme.colors.palette.zinc[850],
  },
  agentItemPressed: {
    backgroundColor: theme.colors.palette.zinc[800],
  },
  agentContent: {
    flex: 1,
    gap: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  agentTitle: {
    flex: 1,
    fontSize: theme.fontSize.base,
    fontWeight: {
      xs: "400",
      md: "300",
    },
    color: theme.colors.palette.zinc[200],
  },
  agentTitleHighlighted: {
    color: theme.colors.foreground,
  },
  secondaryRow: {
    fontSize: theme.fontSize.sm,
    fontWeight: "300",
    color: theme.colors.mutedForeground,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
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
    backgroundColor: theme.colors.card,
    borderTopLeftRadius: theme.borderRadius["2xl"],
    borderTopRightRadius: theme.borderRadius["2xl"],
    paddingHorizontal: theme.spacing[6],
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[6],
    gap: theme.spacing[4],
  },
  sheetHandle: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.muted,
  },
  sheetTitle: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  sheetSubtitle: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.mutedForeground,
  },
  sheetButton: {
    borderRadius: theme.borderRadius.lg,
    paddingVertical: theme.spacing[3],
    alignItems: "center",
    justifyContent: "center",
  },
  sheetDeleteButton: {
    backgroundColor: theme.colors.destructive,
  },
  sheetDeleteText: {
    color: theme.colors.destructiveForeground,
    fontWeight: theme.fontWeight.semibold,
  },
  sheetDeleteTextDisabled: {
    opacity: 0.5,
  },
  sheetCancelButton: {
    backgroundColor: theme.colors.muted,
  },
  sheetCancelText: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.semibold,
  },
}));
