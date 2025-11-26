import { View } from "react-native";
import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import ReanimatedAnimated, { useAnimatedStyle } from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import { HomeHeader } from "@/components/headers/home-header";
import { EmptyState } from "@/components/empty-state";
import { AgentList } from "@/components/agent-list";
import { CreateAgentModal, ImportAgentModal } from "@/components/create-agent-modal";
import { useAggregatedAgents } from "@/hooks/use-aggregated-agents";
import { useLocalSearchParams } from "expo-router";

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const aggregatedAgents = useAggregatedAgents();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [createModalMounted, setCreateModalMounted] = useState(false);
  const [importModalMounted, setImportModalMounted] = useState(false);
  const [pendingImportServerId, setPendingImportServerId] = useState<string | null>(null);
  const { modal, flow, action, serverId: serverIdParam } = useLocalSearchParams<{
    modal?: string;
    flow?: string;
    action?: string;
    serverId?: string;
  }>();
  const deepLinkHandledRef = useRef<string | null>(null);

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

  const aggregatedCount = aggregatedAgents.reduce((count, group) => count + group.agents.length, 0);
  const hasAgents = aggregatedCount > 0;

  const handleCreateAgent = useCallback(() => {
    setCreateModalMounted(true);
    setShowCreateModal(true);
  }, []);

  const openImportModal = useCallback((serverIdOverride?: string | null) => {
    setPendingImportServerId(serverIdOverride ?? null);
    setImportModalMounted(true);
    setShowImportModal(true);
  }, []);

  const handleImportAgent = useCallback(() => {
    openImportModal();
  }, [openImportModal]);

  const handleCloseCreateModal = useCallback(() => {
    setShowCreateModal(false);
  }, []);

  const handleCloseImportModal = useCallback(() => {
    setShowImportModal(false);
    setPendingImportServerId(null);
  }, []);

  const wantsImportDeepLink = useMemo(() => {
    const values = [modal, flow, action];
    return values.some(
      (value) => typeof value === "string" && value.trim().toLowerCase() === "import"
    );
  }, [action, flow, modal]);
  const deepLinkServerId = typeof serverIdParam === "string" ? serverIdParam : null;
  const deepLinkKey = useMemo(() => {
    if (!wantsImportDeepLink) {
      return null;
    }
    return JSON.stringify({
      action: action ?? null,
      flow: flow ?? null,
      modal: modal ?? null,
      serverId: deepLinkServerId,
    });
  }, [action, flow, modal, deepLinkServerId, wantsImportDeepLink]);

  useEffect(() => {
    if (!wantsImportDeepLink || !deepLinkKey) {
      deepLinkHandledRef.current = null;
      return;
    }
    if (deepLinkHandledRef.current === deepLinkKey) {
      return;
    }
    deepLinkHandledRef.current = deepLinkKey;
    openImportModal(deepLinkServerId);
  }, [deepLinkKey, deepLinkServerId, openImportModal, wantsImportDeepLink]);

  return (
    <View style={styles.container}>
      {/* Header */}
      <HomeHeader
        onCreateAgent={handleCreateAgent}
        onImportAgent={handleImportAgent}
      />

      {/* Content Area with Keyboard Animation */}
      <ReanimatedAnimated.View style={[styles.content, animatedKeyboardStyle]}>
        {hasAgents ? (
          <AgentList agentGroups={aggregatedAgents} />
        ) : (
          <EmptyState
            onCreateAgent={handleCreateAgent}
            onImportAgent={handleImportAgent}
          />
        )}
      </ReanimatedAnimated.View>

      {/* Create Agent Modal */}
      {createModalMounted ? (
        <CreateAgentModal
          isVisible={showCreateModal}
          onClose={handleCloseCreateModal}
        />
      ) : null}
      {importModalMounted ? (
        <ImportAgentModal
          isVisible={showImportModal}
          onClose={handleCloseImportModal}
          serverId={pendingImportServerId}
        />
      ) : null}
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
