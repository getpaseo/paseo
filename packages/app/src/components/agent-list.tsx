import { View, Text, Pressable, ScrollView } from "react-native";
import { router } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { Agent } from "@/contexts/session-context";
import type { AgentStatus } from "@server/server/acp/types";

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
  const agentArray = Array.from(agents.values());

  function handleAgentPress(agentId: string) {
    router.push(`/agent/${agentId}`);
  }

  return (
    <ScrollView style={styles.container} showsVerticalScrollIndicator={false}>
      {agentArray.map((agent) => {
        const statusColor = getStatusColor(agent.status);
        const statusLabel = getStatusLabel(agent.status);

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

              <View style={styles.directoryRow}>
                <Text
                  style={styles.agentDirectory}
                  numberOfLines={1}
                >
                  {agent.cwd}
                </Text>

                <View style={styles.statusBadge}>
                  <View
                    style={[styles.statusDot, { backgroundColor: statusColor }]}
                  />
                  <Text style={[styles.statusText, { color: statusColor }]}>
                    {statusLabel}
                  </Text>
                </View>
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
  directoryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  agentDirectory: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.mutedForeground,
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
}));
