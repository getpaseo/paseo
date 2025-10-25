import { View, Text, Pressable, ScrollView } from "react-native";
import { router } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { Agent } from "@/contexts/session-context";
import type { AgentStatus } from "@server/server/acp/types";
import { formatTimeAgo } from "@/utils/time";

interface AgentListProps {
  agents: Map<string, Agent>;
}

function getStatusColor(status: AgentStatus): string {
  switch (status) {
    case "initializing":
      return "#FFA500";
    case "ready":
      return "#2563EB";
    case "processing":
      return "#FACC15";
    case "completed":
      return "#10B981";
    case "failed":
      return "#EF4444";
    case "killed":
      return "#6B7280";
    default:
      return "#6B7280";
  }
}

function getStatusLabel(status: AgentStatus): string {
  switch (status) {
    case "initializing":
      return "Initializing";
    case "ready":
      return "Ready";
    case "processing":
      return "Processing";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "killed":
      return "Killed";
    default:
      return "Unknown";
  }
}

export function AgentList({ agents }: AgentListProps) {
  const { theme } = useUnistyles();
  
  // Sort agents by lastActivityAt (most recent first)
  const agentArray = Array.from(agents.values()).sort((a, b) => {
    return b.lastActivityAt.getTime() - a.lastActivityAt.getTime();
  });

  function handleAgentPress(agentId: string) {
    router.push(`/agent/${agentId}`);
  }

  return (
    <ScrollView style={styles.container} showsVerticalScrollIndicator={false}>
      {agentArray.map((agent) => {
        const statusColor = getStatusColor(agent.status);
        const statusLabel = getStatusLabel(agent.status);
        const timeAgo = formatTimeAgo(agent.lastActivityAt);

        return (
          <Pressable
            key={agent.id}
            style={({ pressed }) => [
              styles.agentItem,
              pressed && styles.agentItemPressed,
            ]}
            onPress={() => handleAgentPress(agent.id)}
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
                <View style={styles.statusBadge}>
                  <View
                    style={[styles.statusDot, { backgroundColor: statusColor }]}
                  />
                  <Text style={[styles.statusText, { color: statusColor }]}>
                    {statusLabel}
                  </Text>
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
}));
