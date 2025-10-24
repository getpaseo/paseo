import { useEffect } from "react";
import { View, Pressable, StyleSheet as RNStyleSheet } from "react-native";
import { usePathname } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { AudioLines } from "lucide-react-native";
import { useRealtime } from "@/contexts/realtime-context";
import { useSession } from "@/contexts/session-context";
import { useFooterControls, FOOTER_HEIGHT } from "@/contexts/footer-controls-context";
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
  const { controls } = useFooterControls();

  // Determine current screen type
  const isAgentScreen = pathname?.startsWith("/agent/");

  const hasRegisteredControls = !!controls;
  const showAgentControls = isAgentScreen && hasRegisteredControls;

  const transition = useSharedValue(isRealtimeMode ? 1 : 0);

  useEffect(() => {
    if (showAgentControls) {
      transition.value = withTiming(isRealtimeMode ? 1 : 0, { duration: 250 });
    }
  }, [isRealtimeMode, showAgentControls]);

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
      <View
        style={[
          styles.container,
          {
            paddingBottom: insets.bottom,
            height: FOOTER_HEIGHT + insets.bottom,
          },
        ]}
      >
        <View style={styles.content}>
          <Animated.View
            style={[RNStyleSheet.absoluteFillObject, agentControlsAnimatedStyle]}
          >
            {controls}
          </Animated.View>
          <Animated.View
            style={[RNStyleSheet.absoluteFillObject, realtimeAnimatedStyle]}
          >
            <RealtimeControls />
          </Animated.View>
        </View>
      </View>
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
        ]}
        entering={FadeIn.duration(400)}
        exiting={FadeOut.duration(250)}
      >
        <RealtimeControls />
      </Animated.View>
    );
  }

  // For home and orchestrator screens, show centered realtime button
  return (
    <Animated.View
      entering={FadeIn.duration(250)}
      exiting={FadeOut.duration(250)}
      style={[
        styles.container,
        {
          paddingBottom: insets.bottom,
          height: FOOTER_HEIGHT + insets.bottom,
        },
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
  content: {
    flex: 1,
    height: FOOTER_HEIGHT,
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
