import { View, Text, Pressable, ScrollView } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { Agent } from "@/contexts/session-context";

export interface ActiveProcessesProps {
  agents: Agent[];
  viewMode: "orchestrator" | "agent";
  activeAgentId: string | null;
  onSelectAgent: (serverId: string, id: string) => void;
  onSelectOrchestrator: () => void;
}

function getAgentStatusColor(status: Agent["status"]): string {
  switch (status) {
    case "initializing":
      return "#f59e0b";
    case "idle":
      return "#22c55e";
    case "running":
      return "#3b82f6";
    case "error":
      return "#ef4444";
    case "closed":
      return "#9ca3af";
    default:
      return "#9ca3af";
  }
}

function getModeName(modeId?: string, availableModes?: Agent["availableModes"]): string {
  if (!modeId) return "unknown";
  const mode = availableModes?.find((m) => m.id === modeId);
  return mode?.label || modeId;
}

function getModeColor(modeId?: string): string {
  if (!modeId) return "#9ca3af"; // gray

  // Color based on common mode types
  if (modeId.includes("ask")) return "#f59e0b"; // orange - asks permission
  if (modeId.includes("code")) return "#22c55e"; // green - writes code
  if (modeId.includes("architect") || modeId.includes("plan")) return "#3b82f6"; // blue - plans

  return "#9ca3af"; // gray - unknown
}

const styles = StyleSheet.create((theme) => ({
  container: {
    backgroundColor: theme.colors.card,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  header: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  backButton: {
    backgroundColor: theme.colors.muted,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  backButtonActive: {
    backgroundColor: theme.colors.palette.zinc[700],
  },
  backButtonText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: '600',
    textAlign: 'center',
  },
  scrollView: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  processItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  processItemActive: {
    backgroundColor: theme.colors.primary,
  },
  processItemInactive: {
    backgroundColor: theme.colors.muted,
  },
  agentIcon: {
    width: 12,
    height: 12,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.palette.blue[500],
  },
  commandIcon: {
    width: 12,
    height: 12,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.palette.purple[500],
  },
  processText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: '500',
  },
  processTextActive: {
    color: theme.colors.primaryForeground,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
  },
  modeIndicator: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    opacity: 0.3,
  },
}));

export function ActiveProcesses({
  agents,
  viewMode,
  activeAgentId,
  onSelectAgent,
  onSelectOrchestrator,
}: ActiveProcessesProps) {
  // Only show if there's at least one agent
  if (agents.length === 0) {
    return null;
  }

  return (
    <View style={styles.container}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.scrollView}
        contentContainerStyle={{ gap: 8 }}
      >
        {/* Orchestrator pill */}
        <Pressable
          onPress={onSelectOrchestrator}
          style={({ pressed }) => [
            styles.processItem,
            viewMode === 'orchestrator' ? styles.processItemActive : styles.processItemInactive,
            pressed && { opacity: 0.7 },
          ]}
        >
          <View style={styles.agentIcon} />
          <Text style={[
            styles.processText,
            viewMode === 'orchestrator' && styles.processTextActive,
          ]}>Orchestrator</Text>
        </Pressable>

        {/* Agent pills */}
        {agents.map((agent) => {
          const isActive = viewMode === 'agent' && activeAgentId === agent.id;

          return (
            <Pressable
              key={`agent-${agent.id}`}
              onPress={() => onSelectAgent(agent.serverId, agent.id)}
              style={({ pressed }) => [
                styles.processItem,
                isActive ? styles.processItemActive : styles.processItemInactive,
                pressed && { opacity: 0.7 },
              ]}
            >
              <View style={styles.agentIcon} />

              <Text style={[
                styles.processText,
                isActive && styles.processTextActive,
              ]}>{agent.id.substring(0, 8)}</Text>

              <View style={[styles.statusDot, { backgroundColor: getAgentStatusColor(agent.status) }]} />

              {agent.currentModeId && (
                <View style={[styles.modeIndicator, { backgroundColor: getModeColor(agent.currentModeId) }]} />
              )}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}
