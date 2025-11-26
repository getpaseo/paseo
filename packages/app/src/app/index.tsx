import { View, Text } from "react-native";
import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import ReanimatedAnimated, { useAnimatedStyle } from "react-native-reanimated";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { HomeHeader } from "@/components/headers/home-header";
import { EmptyState } from "@/components/empty-state";
import { AgentList } from "@/components/agent-list";
import { CreateAgentModal, ImportAgentModal } from "@/components/create-agent-modal";
import { useSession } from "@/contexts/session-context";
import { useAggregatedAgents } from "@/hooks/use-aggregated-agents";
import { useDaemonConnections } from "@/contexts/daemon-connections-context";
import { formatConnectionStatus, getConnectionStatusTone, type ConnectionStatusTone } from "@/utils/daemons";
import { useLocalSearchParams } from "expo-router";

export default function HomeScreen() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const { agents } = useSession();
  const { connectionStates } = useDaemonConnections();
  const aggregatedAgents = useAggregatedAgents(agents);
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
  const connectionIssues = useMemo(() => {
    return Array.from(connectionStates.values()).filter(
      (entry) => entry.status === "connecting" || entry.status === "offline" || entry.status === "error"
    );
  }, [connectionStates]);
  const statusColors: Record<ConnectionStatusTone, string> = {
    success: theme.colors.palette.green[400],
    warning: theme.colors.palette.amber[500],
    error: theme.colors.destructive,
    muted: theme.colors.mutedForeground,
  };

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

      {connectionIssues.length > 0 ? (
        <View style={styles.connectionBanner}>
          {connectionIssues.map((entry) => {
            const tone = getConnectionStatusTone(entry.status);
            const statusColor = statusColors[tone];
            return (
              <View key={entry.daemon.id} style={styles.connectionRow}>
                <View style={styles.connectionHeader}>
                  <View style={[styles.connectionDot, { backgroundColor: statusColor }]} />
                  <Text style={styles.connectionLabel}>
                    {entry.daemon.label} · {formatConnectionStatus(entry.status)}
                  </Text>
                </View>
                {entry.lastError ? (
                  <Text style={styles.connectionError} numberOfLines={2}>
                    {entry.lastError}
                  </Text>
                ) : null}
              </View>
            );
          })}
        </View>
      ) : null}

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
  connectionBanner: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[4],
    gap: theme.spacing[2],
  },
  connectionRow: {
    backgroundColor: theme.colors.card,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    gap: theme.spacing[1],
  },
  connectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  connectionDot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
  },
  connectionLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  connectionError: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.xs,
  },
  content: {
    flex: 1,
  },
}));
