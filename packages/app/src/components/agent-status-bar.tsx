import { View, Text, Pressable } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ChevronDown } from "lucide-react-native";
import { useState } from "react";
import { ModeSelectorModal } from "./mode-selector-modal";
import { useSessionStore } from "@/stores/session-store";

interface AgentStatusBarProps {
  agentId: string;
  serverId: string;
}

export function AgentStatusBar({ agentId, serverId }: AgentStatusBarProps) {
  const { theme } = useUnistyles();

  // Select only the specific agent (not all agents)
  const agent = useSessionStore((state) =>
    state.sessions[serverId]?.agents?.get(agentId)
  );

  // Get the setAgentMode action (actions are stable, won't cause rerenders)
  const setAgentMode = useSessionStore(
    (state) => state.sessions[serverId]?.methods?.setAgentMode
  );

  const [showModeSelector, setShowModeSelector] = useState(false);

  if (!agent) {
    return null;
  }

  function handleModeChange(modeId: string) {
    if (setAgentMode) {
      setAgentMode(agentId, modeId);
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
            {agent.availableModes?.find((m) => m.id === agent.currentModeId)
              ?.label ||
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
    backgroundColor: theme.colors.popover,
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius["2xl"],
  },
  modeBadgePressed: {
    backgroundColor: theme.colors.background,
  },
  modeBadgeText: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    textTransform: "capitalize",
  },
}));
