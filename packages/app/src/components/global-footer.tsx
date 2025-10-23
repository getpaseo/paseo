import { View, Pressable } from "react-native";
import { usePathname, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { AudioLines } from "lucide-react-native";
import { useRealtime } from "@/contexts/realtime-context";
import { useSession } from "@/contexts/session-context";
import { RealtimeControls } from "./realtime-controls";

export function GlobalFooter() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const params = useLocalSearchParams();
  const { isRealtimeMode, startRealtime } = useRealtime();
  const { ws } = useSession();

  // Determine current screen type
  const isAgentScreen = pathname?.startsWith("/agent/");
  const isOrchestratorScreen = pathname === "/orchestrator";
  const isHomeScreen = pathname === "/";

  // If realtime is active, always show realtime controls
  if (isRealtimeMode) {
    return (
      <View style={[styles.container, { paddingBottom: insets.bottom }]}>
        <RealtimeControls />
      </View>
    );
  }

  // If on agent screen and realtime is off, hide footer (agent has its own controls)
  if (isAgentScreen) {
    return null;
  }

  // For home and orchestrator screens, show centered realtime button
  return (
    <View style={[styles.container, { paddingBottom: insets.bottom }]}>
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
    </View>
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
