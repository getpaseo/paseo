import { useEffect, useMemo } from "react";
import { View, Text, ActivityIndicator } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import ReanimatedAnimated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { BackHeader } from "@/components/headers/back-header";
import { AgentStreamView } from "@/components/agent-stream-view";
import { AgentInputArea } from "@/components/agent-input-area";
import { useSession } from "@/contexts/session-context";
import { useFooterControls } from "@/contexts/footer-controls-context";

export default function AgentScreen() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { agents, agentStreamState, pendingPermissions, respondToPermission, initializeAgent } = useSession();
  const { registerFooterControls, unregisterFooterControls } = useFooterControls();

  // Keyboard animation
  const { height: keyboardHeight } = useReanimatedKeyboardAnimation();
  const bottomInset = useSharedValue(insets.bottom);

  useEffect(() => {
    bottomInset.value = insets.bottom;
  }, [insets.bottom, bottomInset]);

  const animatedKeyboardStyle = useAnimatedStyle(() => {
    "worklet";
    const absoluteHeight = Math.abs(keyboardHeight.value);
    const shift = Math.max(0, absoluteHeight - bottomInset.value);
    return {
      transform: [{ translateY: -shift }],
    };
  });

  const agent = id ? agents.get(id) : undefined;
  const streamItems = id ? agentStreamState.get(id) || [] : [];
  const agentPermissions = new Map(
    Array.from(pendingPermissions.entries()).filter(([_, perm]) => perm.agentId === id)
  );

  // Agent is initializing if we don't have stream state yet
  const isInitializing = id ? !agentStreamState.has(id) : false;

  useEffect(() => {
    if (!id) {
      return;
    }
    initializeAgent({ agentId: id });
  }, [id, initializeAgent]);

  const agentControls = useMemo(() => {
    if (!id) return null;
    return <AgentInputArea agentId={id} />;
  }, [id]);

  useEffect(() => {
    if (!agentControls || !agent || isInitializing) {
      unregisterFooterControls();
      return;
    }

    registerFooterControls(agentControls);

    return () => {
      unregisterFooterControls();
    };
  }, [agentControls, agent, isInitializing, registerFooterControls, unregisterFooterControls]);

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
      <View style={styles.contentContainer}>
        <ReanimatedAnimated.View style={[styles.content, animatedKeyboardStyle]}>
          {isInitializing ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color={theme.colors.primary} />
              <Text style={styles.loadingText}>Loading agent...</Text>
            </View>
          ) : (
            <AgentStreamView
              agentId={id!}
              agent={agent}
              streamItems={streamItems}
              pendingPermissions={agentPermissions}
              onPermissionResponse={(requestId, optionId) =>
                respondToPermission(requestId, id!, agent.sessionId || "", [optionId])
              }
            />
          )}
        </ReanimatedAnimated.View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  contentContainer: {
    flex: 1,
    overflow: "hidden",
  },
  content: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
  },
  loadingText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.mutedForeground,
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
