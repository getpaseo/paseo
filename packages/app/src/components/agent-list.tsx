import { View, Text, Pressable, FlatList, Modal, RefreshControl, type ListRenderItem } from "react-native";
import { useCallback, useState, useMemo } from "react";
import { router } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { formatTimeAgo } from "@/utils/time";
import { getAgentProviderDefinition } from "@server/server/agent/provider-manifest";
import { type AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useSessionStore } from "@/stores/session-store";
import { buildAgentNavigationKey, startNavigationTiming } from "@/utils/navigation-timing";

interface AgentListProps {
  agents: AggregatedAgent[];
  isRefreshing?: boolean;
  onRefresh?: () => void;
  selectedAgentId?: string;
}

export function AgentList({ agents, isRefreshing = false, onRefresh, selectedAgentId }: AgentListProps) {
  const { theme } = useUnistyles();
  const [actionAgent, setActionAgent] = useState<AggregatedAgent | null>(null);

  // Sort agents with requires attention at the top
  const sortedAgents = useMemo(() => {
    return [...agents].sort((a, b) => {
      // Requires attention first
      if (a.requiresAttention && !b.requiresAttention) return -1;
      if (!a.requiresAttention && b.requiresAttention) return 1;
      return 0;
    });
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
      router.push({
        pathname: "/agent/[serverId]/[agentId]",
        params: {
          serverId,
          agentId,
        },
      });
    },
    [isActionSheetVisible]
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
      const providerLabel = getAgentProviderDefinition(agent.provider).label;
      const isRunning = agent.status === "running";
      const isSelected = selectedAgentId === agent.id;

      return (
        <Pressable
          style={({ pressed }) => [
            styles.agentItem,
            isSelected && styles.agentItemSelected,
            pressed && styles.agentItemPressed,
          ]}
          onPress={() => handleAgentPress(agent.serverId, agent.id)}
          onLongPress={() => handleAgentLongPress(agent)}
        >
          <View style={styles.agentContent}>
            <View style={styles.titleRow}>
              <Text
                style={styles.agentTitle}
                numberOfLines={1}
              >
                {agent.title || "New Agent"}
              </Text>
              <View style={[styles.hostBadge, { backgroundColor: theme.colors.muted }]}>
                <Text
                  style={[styles.hostText, { color: theme.colors.mutedForeground }]}
                  numberOfLines={1}
                >
                  {agent.serverLabel}
                </Text>
              </View>
            </View>

            <Text style={styles.agentDirectory} numberOfLines={1}>
              {agent.cwd}
            </Text>

            <View style={styles.statusRow}>
              <View style={styles.statusGroup}>
                <View
                  style={[styles.providerBadge, { backgroundColor: theme.colors.muted }]}
                >
                  <Text
                    style={[styles.providerText, { color: theme.colors.mutedForeground }]}
                    numberOfLines={1}
                  >
                    {providerLabel}
                  </Text>
                </View>

                {isRunning ? (
                  <View style={styles.statusBadge}>
                    <View style={[styles.statusDot, { backgroundColor: "#3b82f6" }]} />
                    <Text style={[styles.statusText, { color: "#3b82f6" }]}>
                      Running
                    </Text>
                  </View>
                ) : agent.requiresAttention ? (
                  <View style={styles.statusBadge}>
                    <View style={[styles.statusDot, { backgroundColor: "#22c55e" }]} />
                    <Text style={[styles.statusText, { color: "#22c55e" }]}>
                      Finished
                    </Text>
                  </View>
                ) : null}
              </View>

              <Text style={styles.timeAgo}>
                {timeAgo}
              </Text>
            </View>
          </View>
        </Pressable>
      );
    },
    [handleAgentLongPress, handleAgentPress, selectedAgentId, theme.colors.muted, theme.colors.mutedForeground, theme.colors.primary, theme.colors.primaryForeground]
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
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
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
  },
  listContent: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
  agentItem: {
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
    marginBottom: theme.spacing[2],
    backgroundColor: theme.colors.muted,
    borderWidth: 1,
    borderColor: "transparent",
  },
  agentItemSelected: {
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.primary,
  },
  agentItemPressed: {
    opacity: 0.7,
    backgroundColor: theme.colors.accent,
  },
  agentContent: {
    flex: 1,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    marginBottom: theme.spacing[1],
  },
  agentTitle: {
    flex: 1,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  hostBadge: {
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
  },
  hostText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
  },
  agentDirectory: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.mutedForeground,
    marginBottom: theme.spacing[1],
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  statusGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  providerBadge: {
    borderRadius: theme.borderRadius.full,
  },
  providerText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    textTransform: "uppercase",
  },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
  },
  statusText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
  },
  timeAgo: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.mutedForeground,
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
