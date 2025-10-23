import { View } from "react-native";
import { useRef, useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import ReanimatedAnimated, { useAnimatedStyle } from "react-native-reanimated";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { BackHeader } from "@/components/headers/back-header";
import { OrchestratorMessagesView } from "@/components/orchestrator-messages-view";
import { useSession } from "@/contexts/session-context";
import type { ScrollView } from "react-native";
import type { Artifact } from "@/components/artifact-drawer";

export default function OrchestratorScreen() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const { messages, currentAssistantMessage } = useSession();
  const scrollViewRef = useRef<ScrollView>(null);
  const [currentArtifact, setCurrentArtifact] = useState<Artifact | null>(null);

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

  function handleArtifactClick(artifactId: string) {
    // TODO: Implement artifact drawer
    console.log("[Orchestrator] Artifact clicked:", artifactId);
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <BackHeader title="Activity" />

      {/* Content Area with Keyboard Animation */}
      <ReanimatedAnimated.View style={[styles.content, animatedKeyboardStyle]}>
        <OrchestratorMessagesView
          ref={scrollViewRef}
          messages={messages}
          currentAssistantMessage={currentAssistantMessage}
          onArtifactClick={handleArtifactClick}
        />
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
}));
