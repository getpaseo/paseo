import { View, Text, Pressable, ScrollView } from "react-native";
import { router } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { Agent } from "@/contexts/session-context";
import { formatTimeAgo } from "@/utils/time";
import { getAgentStatusColor, getAgentStatusLabel } from "@/utils/agent-status";

interface AgentListProps {
  agents: Map<string, Agent>;
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
        const statusColor = getAgentStatusColor(agent.status);
        const statusLabel = getAgentStatusLabel(agent.status);
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
