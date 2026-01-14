import { View } from "react-native";
import { useMemo, useRef, useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import ReanimatedAnimated, { useAnimatedStyle } from "react-native-reanimated";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { BackHeader } from "@/components/headers/back-header";
import { OrchestratorMessagesView } from "@/components/orchestrator-messages-view";
import { useSessionDirectory } from "@/hooks/use-session-directory";
import type { ScrollView } from "react-native";
import type { Artifact } from "@/components/artifact-drawer";
import type { MessageEntry } from "@/contexts/session-context";

export default function OrchestratorScreen() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const sessionDirectory = useSessionDirectory();
  const scrollViewRef = useRef<ScrollView>(null);
  const [currentArtifact, setCurrentArtifact] = useState<Artifact | null>(null);
  const aggregatedMessages = useMemo(() => {
    const merged: MessageEntry[] = [];
    sessionDirectory.forEach((session) => {
      if (!session) {
        return;
      }
      merged.push(...session.messages);
    });
    merged.sort((left, right) => left.timestamp - right.timestamp);
    return merged;
  }, [sessionDirectory]);

  const streamingAssistantMessage = useMemo(() => {
    for (const session of sessionDirectory.values()) {
      if (session?.currentAssistantMessage) {
        return session.currentAssistantMessage;
      }
    }
    return "";
  }, [sessionDirectory]);

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
          messages={aggregatedMessages}
          currentAssistantMessage={streamingAssistantMessage}
          onArtifactClick={handleArtifactClick}
        />
      </ReanimatedAnimated.View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  content: {
    flex: 1,
  },
}));
