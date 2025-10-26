import { useEffect, useState } from "react";
import { View, Pressable, Text } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { AudioLines, Users, Plus } from "lucide-react-native";
import { useRealtime } from "@/contexts/realtime-context";
import { useSession } from "@/contexts/session-context";
import { useFooterControls, FOOTER_HEIGHT } from "@/contexts/footer-controls-context";
import { RealtimeControls } from "./realtime-controls";
import { CreateAgentModal } from "./create-agent-modal";
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  withTiming,
  useSharedValue,
} from "react-native-reanimated";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";

export function GlobalFooter() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const router = useRouter();
  const { isRealtimeMode, startRealtime } = useRealtime();
  const { ws } = useSession();
  const { controls } = useFooterControls();
  const [showCreateModal, setShowCreateModal] = useState(false);

  // Determine current screen type
  const isAgentScreen = pathname?.startsWith("/agent/");

  const agentControlsHeight = useSharedValue(FOOTER_HEIGHT);

  const hasRegisteredControls = !!controls;
  const showAgentControls = isAgentScreen && hasRegisteredControls;

  const transition = useSharedValue(isRealtimeMode ? 1 : 0);
  const { height: keyboardHeight } = useReanimatedKeyboardAnimation();
  const bottomInset = insets.bottom;

  useEffect(() => {
    if (showAgentControls) {
      transition.value = withTiming(isRealtimeMode ? 1 : 0, { duration: 250 });
    }
  }, [isRealtimeMode, showAgentControls]);

  const keyboardAnimatedStyle = useAnimatedStyle(
    () => {
      "worklet";
      const absoluteHeight = Math.abs(keyboardHeight.value);
      const shift = Math.max(0, absoluteHeight - bottomInset);
      return {
        transform: [{ translateY: -shift }],
      };
    },
    [bottomInset],
  );

  const containerAnimatedStyle = useAnimatedStyle(
    () => {
      "worklet";
      const agentHeight = Math.max(agentControlsHeight.value, FOOTER_HEIGHT);
      const expandedHeight = agentHeight - (agentHeight - FOOTER_HEIGHT) * transition.value;

      return {
        height: expandedHeight + bottomInset,
      };
    },
    [bottomInset],
  );

  const realtimeAnimatedStyle = useAnimatedStyle(() => {
    return {
      opacity: transition.value,
      pointerEvents: transition.value > 0.5 ? ("auto" as const) : ("none" as const),
    };
  });

  const agentControlsAnimatedStyle = useAnimatedStyle(() => {
    return {
      opacity: 1 - transition.value,
      pointerEvents: transition.value < 0.5 ? ("auto" as const) : ("none" as const),
    };
  });

  if (showAgentControls) {
    return (
      <Animated.View
        style={[
          styles.container,
          {
            paddingBottom: insets.bottom,
          },
          containerAnimatedStyle,
          keyboardAnimatedStyle,
        ]}
      >
        <View style={styles.content}>
          <Animated.View
            onLayout={(event) => {
              agentControlsHeight.value = Math.max(event.nativeEvent.layout.height, FOOTER_HEIGHT);
            }}
            style={[styles.absoluteBottomFill, agentControlsAnimatedStyle]}
          >
            {controls}
          </Animated.View>
          <Animated.View
            style={[styles.absoluteBottomFill, realtimeAnimatedStyle]}
          >
            <RealtimeControls />
          </Animated.View>
        </View>
      </Animated.View>
    );
  }

  if (isAgentScreen) {
    return null;
  }

  // Determine if realtime is active on non-agent screens
  if (isRealtimeMode) {
    return (
      <Animated.View
        style={[
          styles.container,
          {
            paddingBottom: insets.bottom,
            height: FOOTER_HEIGHT + insets.bottom,
          },
          keyboardAnimatedStyle,
        ]}
        entering={FadeIn.duration(400)}
        exiting={FadeOut.duration(250)}
      >
        <RealtimeControls />
      </Animated.View>
    );
  }

  // For home and orchestrator screens, show three buttons
  return (
    <>
      <Animated.View
        entering={FadeIn.duration(250)}
        exiting={FadeOut.duration(250)}
        style={[
          styles.container,
          {
            paddingBottom: insets.bottom,
            height: FOOTER_HEIGHT + insets.bottom,
          },
          keyboardAnimatedStyle,
        ]}
      >
        <View style={styles.threeButtonContainer}>
          <Pressable
            onPress={() => router.push("/")}
            style={({ pressed }) => [
              styles.footerButton,
              pressed && styles.buttonPressed,
            ]}
          >
            <Users size={20} color={theme.colors.foreground} />
            <Text style={styles.footerButtonText}>Agents</Text>
          </Pressable>

          <Pressable
            onPress={() => setShowCreateModal(true)}
            style={({ pressed }) => [
              styles.footerButton,
              pressed && styles.buttonPressed,
            ]}
          >
            <Plus size={20} color={theme.colors.foreground} />
            <Text style={styles.footerButtonText}>New Agent</Text>
          </Pressable>

          <Pressable
            onPress={startRealtime}
            disabled={!ws.isConnected}
            style={({ pressed }) => [
              styles.footerButton,
              !ws.isConnected && styles.buttonDisabled,
              pressed && !ws.isConnected && styles.buttonPressed,
            ]}
          >
            <AudioLines size={20} color={theme.colors.foreground} />
            <Text style={styles.footerButtonText}>Realtime</Text>
          </Pressable>
        </View>
      </Animated.View>

      <CreateAgentModal
        isVisible={showCreateModal}
        onClose={() => setShowCreateModal(false)}
      />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    backgroundColor: theme.colors.background,
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  content: {
    flex: 1,
    minHeight: FOOTER_HEIGHT,
  },
  absoluteBottomFill: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
  },
  threeButtonContainer: {
    flexDirection: "row",
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  footerButton: {
    flex: 1,
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[3],
    gap: theme.spacing[1],
  },
  footerButtonText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonPressed: {
    opacity: 0.5,
  },
}));
