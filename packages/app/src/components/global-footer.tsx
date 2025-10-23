import { View, Pressable } from "react-native";
import { usePathname } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { AudioLines } from "lucide-react-native";
import { useRealtime } from "@/contexts/realtime-context";
import { useSession } from "@/contexts/session-context";
import { RealtimeControls } from "./realtime-controls";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";

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

  // If realtime is active, show realtime controls
  if (isRealtimeMode) {
    return (
      <Animated.View
        entering={FadeIn.duration(400)}
        exiting={FadeOut.duration(250)}
        style={[styles.container, { paddingBottom: insets.bottom }]}
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
