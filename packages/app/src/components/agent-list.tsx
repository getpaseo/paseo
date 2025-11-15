import { View, Text, Pressable, ScrollView, Modal } from "react-native";
import { useCallback, useMemo, useState } from "react";
import { router } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { Agent } from "@/contexts/session-context";
import { useSession } from "@/contexts/session-context";
import { formatTimeAgo } from "@/utils/time";
import { getAgentStatusColor, getAgentStatusLabel } from "@/utils/agent-status";
import { getAgentProviderDefinition } from "@server/server/agent/provider-manifest";

interface AgentListProps {
  agents: Map<string, Agent>;
}

export function AgentList({ agents }: AgentListProps) {
  const { theme } = useUnistyles();
  const { deleteAgent } = useSession();
  const [actionAgent, setActionAgent] = useState<Agent | null>(null);
  const isActionSheetVisible = actionAgent !== null;
  
  // Sort agents by lastActivityAt (most recent first)
  const agentArray = useMemo(() => {
    return Array.from(agents.values()).sort((a, b) => {
      return b.lastActivityAt.getTime() - a.lastActivityAt.getTime();
    });
  }, [agents]);

  const handleAgentPress = useCallback((agentId: string) => {
    if (isActionSheetVisible) {
      return;
    }
    router.push(`/agent/${agentId}`);
  }, [isActionSheetVisible]);

  const handleAgentLongPress = useCallback((agent: Agent) => {
    setActionAgent(agent);
  }, []);

  const handleCloseActionSheet = useCallback(() => {
    setActionAgent(null);
  }, []);

  const handleDeleteAgent = useCallback(() => {
    if (!actionAgent) {
      return;
    }
    deleteAgent(actionAgent.id);
    setActionAgent(null);
  }, [actionAgent, deleteAgent]);

  return (
    <>
      <ScrollView style={styles.container} showsVerticalScrollIndicator={false}>
        {agentArray.map((agent) => {
          const statusColor = getAgentStatusColor(agent.status);
          const statusLabel = getAgentStatusLabel(agent.status);
          const timeAgo = formatTimeAgo(agent.lastActivityAt);
          const providerLabel = getAgentProviderDefinition(agent.provider).label;

          return (
            <Pressable
              key={agent.id}
              style={({ pressed }) => [
                styles.agentItem,
                pressed && styles.agentItemPressed,
              ]}
              onPress={() => handleAgentPress(agent.id)}
              onLongPress={() => handleAgentLongPress(agent)}
            >
              <View style={styles.agentContent}>
                <Text
                  style={styles.agentTitle}
                  numberOfLines={1}
                >
                  {agent.title || "New Agent"}
                </Text>

                <Text
                  style={styles.agentDirectory}
                  numberOfLines={1}
                >
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

                    <View style={styles.statusBadge}>
                      <View
                        style={[styles.statusDot, { backgroundColor: statusColor }]}
                      />
                      <Text style={[styles.statusText, { color: statusColor }]}>
                        {statusLabel}
                      </Text>
                    </View>
                  </View>

                  <Text style={styles.timeAgo}>
                    {timeAgo}
                  </Text>
                </View>
              </View>
            </Pressable>
          );
        })}
      </ScrollView>

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
              Removing this agent only deletes it from Paseo. Claude/Codex keeps the original project.
            </Text>
            <Pressable
              style={[styles.sheetButton, styles.sheetDeleteButton]}
              onPress={handleDeleteAgent}
            >
              <Text style={styles.sheetDeleteText}>Delete agent</Text>
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
  container: {
    flex: 1,
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[4],
  },
  agentItem: {
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
    marginBottom: theme.spacing[2],
    backgroundColor: theme.colors.muted,
  },
  agentItemPressed: {
    opacity: 0.7,
    backgroundColor: theme.colors.accent,
  },
  agentContent: {
    flex: 1,
  },
  agentTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    marginBottom: theme.spacing[1],
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
  sheetCancelButton: {
    backgroundColor: theme.colors.muted,
  },
  sheetCancelText: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.semibold,
  },
}));
