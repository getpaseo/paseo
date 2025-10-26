import { useState } from "react";
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

  const hasRegisteredControls = !!controls;
  const showAgentControls = isAgentScreen && hasRegisteredControls;

  const { height: keyboardHeight } = useReanimatedKeyboardAnimation();
  const bottomInset = insets.bottom;

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

  if (showAgentControls) {
    return (
      <Animated.View
        style={[
          styles.container,
          {
            paddingBottom: insets.bottom,
          },
          keyboardAnimatedStyle,
        ]}
      >
        {controls}
      </Animated.View>
    );
  }

  if (isAgentScreen) {
    return null;
  }

  // For home and orchestrator screens, show three buttons with realtime stacked on top
  const nonAgentFooterHeight = isRealtimeMode
    ? FOOTER_HEIGHT * 2 + insets.bottom
    : FOOTER_HEIGHT + insets.bottom;

  return (
    <>
      <Animated.View
        style={[
          styles.container,
          {
            paddingBottom: insets.bottom,
            height: nonAgentFooterHeight,
          },
          keyboardAnimatedStyle,
        ]}
      >
        <View style={styles.nonAgentContent}>
          {/* Realtime controls - only visible when active */}
          {isRealtimeMode && (
            <Animated.View
              style={styles.realtimeSection}
              entering={FadeIn.duration(250)}
              exiting={FadeOut.duration(250)}
            >
              <RealtimeControls />
            </Animated.View>
          )}

          {/* Three button menu - always visible */}
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
  nonAgentContent: {
    flexDirection: "column",
  },
  realtimeSection: {
    height: FOOTER_HEIGHT,
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  threeButtonContainer: {
    flexDirection: "row",
    padding: theme.spacing[4],
    gap: theme.spacing[3],
    height: FOOTER_HEIGHT,
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
