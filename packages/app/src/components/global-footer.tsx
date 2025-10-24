import { useEffect } from "react";
import { View, Pressable } from "react-native";
import { usePathname } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { AudioLines } from "lucide-react-native";
import { useRealtime } from "@/contexts/realtime-context";
import { useSession } from "@/contexts/session-context";
import { RealtimeControls } from "./realtime-controls";
import Animated, { 
  FadeIn, 
  FadeOut,
  useAnimatedStyle,
  withTiming,
  useSharedValue,
} from "react-native-reanimated";

export function GlobalFooter() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const { isRealtimeMode, startRealtime } = useRealtime();
  const { ws } = useSession();

  // Determine current screen type
  const isAgentScreen = pathname?.startsWith("/agent/");

  // Determine if footer should be visible
  // Hidden when: on agent screen AND realtime is off
  const shouldHide = isAgentScreen && !isRealtimeMode;

  // Controlled opacity for agent screen transitions (synced with AgentInputArea)
  const realtimeOpacity = useSharedValue(isRealtimeMode ? 1 : 0);

  useEffect(() => {
    if (isAgentScreen) {
      // On agent screen, use controlled animation for smooth cross-fade
      realtimeOpacity.value = withTiming(isRealtimeMode ? 1 : 0, { duration: 250 });
    }
  }, [isRealtimeMode, isAgentScreen]);

  const realtimeAnimatedStyle = useAnimatedStyle(() => {
    return {
      opacity: realtimeOpacity.value,
      pointerEvents: realtimeOpacity.value > 0.5 ? ("auto" as const) : ("none" as const),
    };
  });

  // If realtime is active, show realtime controls
  if (isRealtimeMode) {
    return (
      <Animated.View
        style={[
          styles.container, 
          { paddingBottom: insets.bottom },
          // Use controlled opacity on agent screen for smooth transition
          isAgentScreen && realtimeAnimatedStyle
        ]}
        // Keep FadeIn/FadeOut for non-agent screens (home, orchestrator, etc)
        entering={!isAgentScreen ? FadeIn.duration(400) : undefined}
        exiting={!isAgentScreen ? FadeOut.duration(250) : undefined}
      >
        <RealtimeControls />
      </Animated.View>
    );
  }

  // For home and orchestrator screens, show centered realtime button
  // On agent screens, don't render at all
  if (shouldHide) {
    return null;
  }

  return (
    <Animated.View
      entering={FadeIn.duration(250)}
      exiting={FadeOut.duration(250)}
      style={[
        styles.container,
        { paddingBottom: insets.bottom }
      ]}
    >
      <View style={styles.centeredButtonContainer}>
        <Pressable
          onPress={startRealtime}
          disabled={!ws.isConnected}
          style={[
            styles.centeredRealtimeButton,
            !ws.isConnected && styles.buttonDisabled,
          ]}
        >
          <AudioLines size={24} color="white" />
        </Pressable>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    backgroundColor: theme.colors.background,
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  realtimeContainer: {
    backgroundColor: theme.colors.background,
  },
  centeredButtonContainer: {
    padding: theme.spacing[6],
    alignItems: "center",
    justifyContent: "center",
  },
  centeredRealtimeButton: {
    width: 56,
    height: 56,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.palette.blue[600],
    alignItems: "center",
    justifyContent: "center",
  },
  buttonDisabled: {
    opacity: 0.5,
  },
}));
