import { View, Text, Pressable } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ChevronDown } from "lucide-react-native";
import { useState } from "react";
import { ModeSelectorModal } from "./mode-selector-modal";
import { useDaemonSession } from "@/hooks/use-daemon-session";

interface AgentStatusBarProps {
  agentId: string;
  serverId?: string;
}

export function AgentStatusBar({ agentId, serverId }: AgentStatusBarProps) {
  const { theme } = useUnistyles();
  const { agents, setAgentMode } = useDaemonSession(serverId);
  const [showModeSelector, setShowModeSelector] = useState(false);

  const agent = agents.get(agentId);

  if (!agent) {
    return null;
  }

  function handleModeChange(modeId: string) {
    setAgentMode(agentId, modeId);
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
            {agent.availableModes?.find((m) => m.id === agent.currentModeId)?.label ||
              agent.currentModeId ||
              "default"}
          </Text>
          <ChevronDown size={14} color={theme.colors.mutedForeground} />
        </Pressable>
      )}

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
}));
