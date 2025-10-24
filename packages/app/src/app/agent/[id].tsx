import { View, Text } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import ReanimatedAnimated, { useAnimatedStyle, FadeIn } from "react-native-reanimated";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { BackHeader } from "@/components/headers/back-header";
import { AgentStreamView } from "@/components/agent-stream-view";
import { AgentInputArea } from "@/components/agent-input-area";
import { AgentStatusBar } from "@/components/agent-status-bar";
import { useSession } from "@/contexts/session-context";
import { useRealtime } from "@/contexts/realtime-context";

export default function AgentScreen() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { agents, agentStreamState, pendingPermissions, respondToPermission } = useSession();
  const { isRealtimeMode } = useRealtime();

  // Keyboard animation
  const { height: keyboardHeight } = useReanimatedKeyboardAnimation();
  const animatedKeyboardStyle = useAnimatedStyle(() => {
    "worklet";
    const absoluteHeight = Math.abs(keyboardHeight.value);
    const padding = Math.max(0, absoluteHeight - insets.bottom);
    return {
      paddingBottom: padding,
    };
  });

  const agent = id ? agents.get(id) : undefined;
  const streamItems = id ? agentStreamState.get(id) || [] : [];
  const agentPermissions = new Map(
    Array.from(pendingPermissions.entries()).filter(([_, perm]) => perm.agentId === id)
  );

  if (!agent) {
    return (
      <View style={styles.container}>
        <BackHeader />
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>Agent not found</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <BackHeader title={agent.title || "Agent"} />

      {/* Content Area with Keyboard Animation */}
      <ReanimatedAnimated.View style={[styles.content, animatedKeyboardStyle]}>
        <AgentStreamView
          agentId={id!}
          agent={agent}
          streamItems={streamItems}
          pendingPermissions={agentPermissions}
          onPermissionResponse={(requestId, optionId) =>
            respondToPermission(requestId, id!, agent.sessionId || "", [optionId])
          }
        />

        {/* Footer area - status bar + controls */}
        <View style={[styles.footerContainer, { paddingBottom: insets.bottom }]}>
          {/* Status bar - always visible, floating above controls */}
          <AgentStatusBar agentId={id!} />
          
          {/* Controls - only show AgentInputArea when not in realtime mode */}
          {/* When in realtime mode, GlobalFooter handles showing RealtimeControls */}
          {!isRealtimeMode && (
            <View style={styles.controlsContainer}>
              <AgentInputArea agentId={id!} />
            </View>
          )}
        </View>
      </ReanimatedAnimated.View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  content: {
    flex: 1,
  },
  footerContainer: {
    backgroundColor: theme.colors.background,
  },
  controlsContainer: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  errorContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  errorText: {
    fontSize: theme.fontSize.lg,
    color: theme.colors.mutedForeground,
  },
}));
