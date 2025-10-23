import { View } from "react-native";
import { useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import ReanimatedAnimated, { useAnimatedStyle } from "react-native-reanimated";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { HomeHeader } from "@/components/headers/home-header";
import { EmptyState } from "@/components/empty-state";
import { AgentList } from "@/components/agent-list";
import { CreateAgentModal } from "@/components/create-agent-modal";
import { useSession } from "@/contexts/session-context";

export default function HomeScreen() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const { agents } = useSession();
  const [showCreateModal, setShowCreateModal] = useState(false);

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

  const hasAgents = agents.size > 0;

  function handleCreateAgent() {
    setShowCreateModal(true);
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <HomeHeader onCreateAgent={handleCreateAgent} />

      {/* Content Area with Keyboard Animation */}
      <ReanimatedAnimated.View style={[styles.content, animatedKeyboardStyle]}>
        {hasAgents ? (
          <AgentList agents={agents} />
        ) : (
          <EmptyState onCreateAgent={handleCreateAgent} />
        )}
      </ReanimatedAnimated.View>

      {/* Create Agent Modal */}
      <CreateAgentModal
        isVisible={showCreateModal}
        onClose={() => setShowCreateModal(false)}
      />
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
