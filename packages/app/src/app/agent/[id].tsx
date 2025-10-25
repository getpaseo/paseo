import { useEffect, useMemo, useState } from "react";
import { View, Text, ActivityIndicator } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import ReanimatedAnimated, { useAnimatedStyle } from "react-native-reanimated";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { BackHeader } from "@/components/headers/back-header";
import { AgentStreamView } from "@/components/agent-stream-view";
import { AgentInputArea } from "@/components/agent-input-area";
import { AgentStatusBar } from "@/components/agent-status-bar";
import { useSession } from "@/contexts/session-context";
import { useFooterControls } from "@/contexts/footer-controls-context";

export default function AgentScreen() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { agents, agentStreamState, pendingPermissions, respondToPermission, initializeAgent } = useSession();
  const { registerFooterControls, unregisterFooterControls } = useFooterControls();
  const [isContentReady, setIsContentReady] = useState(false);

  // Keyboard animation
  const { height: keyboardHeight } = useReanimatedKeyboardAnimation();
  const bottomInset = insets.bottom;
  const animatedKeyboardStyle = useAnimatedStyle(() => {
    "worklet";
    const absoluteHeight = Math.abs(keyboardHeight.value);
    const padding = Math.max(0, absoluteHeight - bottomInset);
    return {
      paddingBottom: padding,
    };
  });

  const agent = id ? agents.get(id) : undefined;
  const streamItems = id ? agentStreamState.get(id) || [] : [];
  const agentPermissions = new Map(
    Array.from(pendingPermissions.entries()).filter(([_, perm]) => perm.agentId === id)
  );

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

  // Defer heavy rendering to next frame for faster initial paint
  useEffect(() => {
    let isMounted = true;
    let frameId: number | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const markReady = () => {
      if (isMounted) {
        setIsContentReady(true);
      }
    };

    if (typeof requestAnimationFrame === "function") {
      frameId = requestAnimationFrame(markReady);
    } else {
      timeoutId = setTimeout(markReady, 0);
    }

    return () => {
      isMounted = false;

      if (frameId !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(frameId);
      }

      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
    };
  }, []);

  useEffect(() => {
    if (!agentControls || !agent || !isContentReady) {
      unregisterFooterControls();
      return;
    }

    registerFooterControls(agentControls);

    return () => {
      unregisterFooterControls();
    };
  }, [agentControls, agent, isContentReady, registerFooterControls, unregisterFooterControls]);

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
        {isContentReady ? (
          <>
            <AgentStreamView
              agentId={id!}
              agent={agent}
              streamItems={streamItems}
              pendingPermissions={agentPermissions}
              onPermissionResponse={(requestId, optionId) =>
                respondToPermission(requestId, id!, agent.sessionId || "", [optionId])
              }
            />

            {/* Footer area - status bar pinned within screen */}
            <View style={styles.footerContainer}>
              <AgentStatusBar agentId={id!} />
            </View>
          </>
        ) : (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
          </View>
        )}
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
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
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
