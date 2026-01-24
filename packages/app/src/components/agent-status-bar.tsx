import { View, Text } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ChevronDown } from "lucide-react-native";
import { useSessionStore } from "@/stores/session-store";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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
        <DropdownMenu>
          <DropdownMenuTrigger
            style={({ pressed }) => [
              styles.modeBadge,
              pressed && styles.modeBadgePressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Select agent mode"
            testID="agent-mode-selector"
          >
            <Text style={styles.modeBadgeText}>
              {agent.availableModes?.find((m) => m.id === agent.currentModeId)
                ?.label ||
                agent.currentModeId ||
                "default"}
            </Text>
            <ChevronDown size={14} color={theme.colors.foregroundMuted} />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            align="center"
            fullWidth
            testID="agent-mode-menu"
          >
            <DropdownMenuLabel>Mode</DropdownMenuLabel>
            {agent.availableModes.map((mode) => {
              const isActive = mode.id === agent.currentModeId;
              return (
                <DropdownMenuItem
                  key={mode.id}
                  selected={isActive}
                  selectedVariant="accent"
                  description={mode.description}
                  onSelect={() => handleModeChange(mode.id)}
                >
                  {mode.label}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
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
    backgroundColor: theme.colors.surface2,
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius["2xl"],
  },
  modeBadgePressed: {
    backgroundColor: theme.colors.surface0,
  },
  modeBadgeText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    textTransform: "capitalize",
  },
}));
