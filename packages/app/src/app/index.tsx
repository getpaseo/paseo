import { View, ActivityIndicator } from "react-native";
import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { useFocusEffect } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import ReanimatedAnimated, { useAnimatedStyle } from "react-native-reanimated";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { HomeHeader } from "@/components/headers/home-header";
import { HomeFooter } from "@/components/home-footer";
import { EmptyState } from "@/components/empty-state";
import { AgentList } from "@/components/agent-list";
import { CreateAgentModal, ImportAgentModal } from "@/components/create-agent-modal";
import { useAggregatedAgents } from "@/hooks/use-aggregated-agents";
import { useLocalSearchParams, useRouter } from "expo-router";
import { endNavigationTiming, HOME_NAVIGATION_KEY } from "@/utils/navigation-timing";

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const { theme } = useUnistyles();
  const {
    agents: aggregatedAgents,
    isInitialLoad,
    isRevalidating,
    refreshAll,
  } = useAggregatedAgents();
  const router = useRouter();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [pendingImportServerId, setPendingImportServerId] = useState<string | null>(null);
  const { modal, flow, action, serverId: serverIdParam } = useLocalSearchParams<{
    modal?: string;
    flow?: string;
    action?: string;
    serverId?: string;
  }>();
  const deepLinkHandledRef = useRef<string | null>(null);
  const createDeepLinkHandledRef = useRef<string | null>(null);

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

  const hasAgents = aggregatedAgents.length > 0;

  const handleCreateAgent = useCallback(() => {
    router.push("/agent/new");
  }, [router]);

  const openImportModal = useCallback((serverIdOverride?: string | null) => {
    setPendingImportServerId(serverIdOverride ?? null);
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
  const wantsCreateDeepLink = useMemo(() => {
    const values = [modal, flow, action];
    return values.some(
      (value) => typeof value === "string" && value.trim().toLowerCase() === "create"
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
  const createDeepLinkKey = useMemo(() => {
    if (!wantsCreateDeepLink) {
      return null;
    }
    return JSON.stringify({
      action: action ?? null,
      flow: flow ?? null,
      modal: modal ?? null,
    });
  }, [action, flow, modal, wantsCreateDeepLink]);

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
  useEffect(() => {
    if (!wantsCreateDeepLink || !createDeepLinkKey) {
      createDeepLinkHandledRef.current = null;
      return;
    }
    if (createDeepLinkHandledRef.current === createDeepLinkKey) {
      return;
    }
    createDeepLinkHandledRef.current = createDeepLinkKey;
    setShowCreateModal(true);
  }, [createDeepLinkKey, wantsCreateDeepLink]);

  useFocusEffect(
    useCallback(() => {
      endNavigationTiming(HOME_NAVIGATION_KEY, { screen: "home" });
    }, [])
  );

  return (
    <View style={styles.container}>
      {/* Header */}
      <HomeHeader
        onCreateAgent={handleCreateAgent}
        onImportAgent={handleImportAgent}
      />

      {/* Content Area with Keyboard Animation */}
      <ReanimatedAnimated.View style={[styles.content, animatedKeyboardStyle]}>
        {isInitialLoad ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={theme.colors.mutedForeground} />
          </View>
        ) : hasAgents ? (
          <AgentList
            agents={aggregatedAgents}
            isRefreshing={isRevalidating}
            onRefresh={refreshAll}
          />
        ) : (
          <EmptyState
            onCreateAgent={handleCreateAgent}
            onImportAgent={handleImportAgent}
          />
        )}
      </ReanimatedAnimated.View>

      {/* Home Footer */}
      <HomeFooter />

      {/* Create Agent Modal */}
      <CreateAgentModal isVisible={showCreateModal} onClose={handleCloseCreateModal} />
      <ImportAgentModal
        isVisible={showImportModal}
        onClose={handleCloseImportModal}
        serverId={pendingImportServerId}
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
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
}));
