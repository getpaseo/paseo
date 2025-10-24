import { View, Text, Pressable } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ChevronDown } from "lucide-react-native";
import { useSession } from "@/contexts/session-context";
import { useState } from "react";
import { ModeSelectorModal } from "./mode-selector-modal";

interface AgentStatusBarProps {
  agentId: string;
}

export function AgentStatusBar({ agentId }: AgentStatusBarProps) {
  const { theme } = useUnistyles();
  const { agents, setAgentMode } = useSession();
  const [showModeSelector, setShowModeSelector] = useState(false);

  const agent = agents.get(agentId);

  if (!agent) {
    return null;
  }

  function handleModeChange(modeId: string) {
    setAgentMode(agentId, modeId);
  }

  function getStatusLabel(status: string): string {
    switch (status) {
      case "ready":
        return "Ready";
      case "processing":
        return "Working";
      case "completed":
        return "Completed";
      case "failed":
        return "Failed";
      case "killed":
        return "Stopped";
      default:
        return status;
    }
  }

  function getStatusColor(status: string): string {
    switch (status) {
      case "ready":
        return theme.colors.palette.green[500];
      case "processing":
        return theme.colors.palette.blue[500];
      case "completed":
        return theme.colors.palette.gray[500];
      case "failed":
        return theme.colors.palette.red[500];
      case "killed":
        return theme.colors.palette.orange[500];
      default:
        return theme.colors.mutedForeground;
    }
  }

  return (
    <View style={styles.container}>
      {/* Agent Mode Badge */}
      {agent.availableModes && agent.availableModes.length > 0 && (
        <Pressable
          onPress={() => setShowModeSelector(true)}
          style={({ pressed }) => [
            styles.modeBadge,
            pressed && styles.modeBadgePressed,
          ]}
        >
          <Text style={styles.modeBadgeText}>
            {agent.availableModes?.find((m) => m.id === agent.currentModeId)?.name ||
              agent.currentModeId ||
              "default"}
          </Text>
          <ChevronDown size={14} color={theme.colors.mutedForeground} />
        </Pressable>
      )}

      {/* Agent Status Indicator */}
      <View style={styles.statusIndicator}>
        <View
          style={[
            styles.statusDot,
            { backgroundColor: getStatusColor(agent.status) },
          ]}
        />
        <Text style={styles.statusText}>{getStatusLabel(agent.status)}</Text>
      </View>

      {/* Mode selector modal */}
      <ModeSelectorModal
        visible={showModeSelector}
        agent={agent}
        onModeChange={handleModeChange}
        onClose={() => setShowModeSelector(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[1],
  },
  modeBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.muted,
    borderRadius: theme.borderRadius.full,
  },
  modeBadgePressed: {
    backgroundColor: theme.colors.accent,
  },
  modeBadgeText: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    textTransform: "capitalize",
  },
  statusIndicator: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusText: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
  },
}));
