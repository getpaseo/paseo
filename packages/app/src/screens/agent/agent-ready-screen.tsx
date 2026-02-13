import { useEffect, useMemo, useRef, useCallback, useState } from "react";
import {
  View,
  Text,
  ActivityIndicator,
  Pressable,
  ScrollView,
  Platform,
  BackHandler,
} from "react-native";
import { useRouter } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { useFocusEffect } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import ReanimatedAnimated, {
  useAnimatedStyle,
  useSharedValue,
  runOnJS,
  interpolate,
  Extrapolation,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { StyleSheet, UnistylesRuntime, useUnistyles } from "react-native-unistyles";
import {
  MoreVertical,
  GitBranch,
  Folder,
  RotateCcw,
  PanelRight,
  CheckCircle2,
} from "lucide-react-native";
import { MenuHeader } from "@/components/headers/menu-header";
import { BackHeader } from "@/components/headers/back-header";
import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import { AgentStreamView } from "@/components/agent-stream-view";
import { AgentInputArea } from "@/components/agent-input-area";
import { ExplorerSidebar } from "@/components/explorer-sidebar";
import { FileDropZone } from "@/components/file-drop-zone";
import type { ImageAttachment } from "@/components/message-input";
import {
  ExplorerSidebarAnimationProvider,
  useExplorerSidebarAnimation,
} from "@/contexts/explorer-sidebar-animation-context";
import { usePanelStore } from "@/stores/panel-store";
import { useDaemonConnections } from "@/contexts/daemon-connections-context";
import type { ConnectionStatus } from "@/contexts/daemon-connections-context";
import { useSessionStore } from "@/stores/session-store";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import type { Agent } from "@/contexts/session-context";
import type { StreamItem } from "@/types/stream";
import {
  buildAgentNavigationKey,
  endNavigationTiming,
  HOME_NAVIGATION_KEY,
  startNavigationTiming,
} from "@/utils/navigation-timing";
import { extractAgentModel } from "@/utils/extract-agent-model";
import { startPerfMonitor } from "@/utils/perf-monitor";
import { shortenPath } from "@/utils/shorten-path";
import { deriveBranchLabel, deriveProjectPath } from "@/utils/agent-display-info";
import { useCheckoutStatusQuery } from "@/hooks/use-checkout-status-query";
import { useAgentInitialization } from "@/hooks/use-agent-initialization";
import { useToast } from "@/contexts/toast-context";
import { getInitDeferred, getInitKey } from "@/utils/agent-initialization";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const DROPDOWN_WIDTH = 220;
const EMPTY_STREAM_ITEMS: StreamItem[] = [];
const RECONNECT_NOTICE_DELAY_MS = 10_000;
const CONNECTED_NOTICE_DURATION_MS = 2_500;

export function AgentReadyScreen({
  serverId,
  agentId,
}: {
  serverId: string;
  agentId: string;
}) {
  const router = useRouter();
  const resolvedAgentId = agentId?.trim() || undefined;
  const resolvedServerId = serverId?.trim() || undefined;
  const { connectionStates } = useDaemonConnections();

  // Check if session exists for this serverId
  const hasSession = useSessionStore((state) =>
    resolvedServerId ? !!state.sessions[resolvedServerId] : false
  );

  const connectionServerId = resolvedServerId ?? null;
  const connection = connectionServerId
    ? connectionStates.get(connectionServerId)
    : null;
  const serverLabel =
    connection?.daemon.label ?? connectionServerId ?? "Selected host";
  const isUnknownDaemon = Boolean(connectionServerId && !connection);
  const connectionStatus =
    connection?.status ?? (isUnknownDaemon ? "offline" : "idle");
  const lastConnectionError = connection?.lastError ?? null;

  const handleBackToHome = useCallback(() => {
    const targetServerId = resolvedServerId;
    const targetAgentId = resolvedAgentId ?? null;
    if (targetServerId && targetAgentId) {
      startNavigationTiming(HOME_NAVIGATION_KEY, {
        from: "agent",
        to: "home",
        targetMs: 300,
        params: {
          serverId: targetServerId,
          agentId: targetAgentId,
        },
      });
    } else {
      startNavigationTiming(HOME_NAVIGATION_KEY, {
        from: "agent",
        to: "home",
        targetMs: 300,
      });
    }
    router.replace("/agent" as any);
  }, [resolvedAgentId, resolvedServerId, router]);

  const focusServerId = resolvedServerId;
  const navigationStatus = hasSession ? "ready" : "session_unavailable";

  useFocusEffect(
    useCallback(() => {
      if (!resolvedAgentId || !focusServerId) {
        return;
      }
      const navigationKey = buildAgentNavigationKey(
        focusServerId,
        resolvedAgentId
      );
      endNavigationTiming(navigationKey, {
        screen: "agent",
        status: navigationStatus,
      });
    }, [focusServerId, navigationStatus, resolvedAgentId])
  );

  if (!hasSession || !resolvedServerId) {
    return (
      <AgentSessionUnavailableState
        onBack={handleBackToHome}
        serverLabel={serverLabel}
        connectionStatus={connectionStatus}
        lastError={lastConnectionError}
        isUnknownDaemon={isUnknownDaemon}
      />
    );
  }

  return (
    <ExplorerSidebarAnimationProvider>
      <AgentScreenContent
        serverId={resolvedServerId}
        agentId={resolvedAgentId}
        connectionStatus={connectionStatus}
      />
    </ExplorerSidebarAnimationProvider>
  );
}

type AgentScreenContentProps = {
  serverId: string;
  agentId?: string;
  connectionStatus: ConnectionStatus;
};

type MissingAgentState =
  | { kind: "idle" }
  | { kind: "resolving" }
  | { kind: "not_found"; message: string }
  | { kind: "error"; message: string };

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isNotFoundErrorMessage(message: string): boolean {
  return /agent not found|not found/i.test(message);
}

function AgentScreenContent({
  serverId,
  agentId,
  connectionStatus,
}: AgentScreenContentProps) {
  const { theme } = useUnistyles();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const addImagesRef = useRef<((images: ImageAttachment[]) => void) | null>(null);

  const handleFilesDropped = useCallback((files: ImageAttachment[]) => {
    addImagesRef.current?.(files);
  }, []);

  const handleAddImagesCallback = useCallback((addImages: (images: ImageAttachment[]) => void) => {
    addImagesRef.current = addImages;
  }, []);

  const isMobile =
    UnistylesRuntime.breakpoint === "xs" || UnistylesRuntime.breakpoint === "sm";

  const mobileView = usePanelStore((state) => state.mobileView);
  const desktopFileExplorerOpen = usePanelStore((state) => state.desktop.fileExplorerOpen);
  const toggleFileExplorer = usePanelStore((state) => state.toggleFileExplorer);
  const openFileExplorer = usePanelStore((state) => state.openFileExplorer);
  const closeToAgent = usePanelStore((state) => state.closeToAgent);
  const setExplorerTab = usePanelStore((state) => state.setExplorerTab);

  // Derive isExplorerOpen from the unified panel state
  const isExplorerOpen = isMobile ? mobileView === "file-explorer" : desktopFileExplorerOpen;
  const openExplorerWithDefaultTab = useCallback(() => {
    // Generic explorer toggles should land on Changes by default.
    setExplorerTab("changes");
    openFileExplorer();
  }, [openFileExplorer, setExplorerTab]);
  const handleToggleExplorer = useCallback(() => {
    if (isExplorerOpen) {
      toggleFileExplorer();
      return;
    }
    openExplorerWithDefaultTab();
  }, [isExplorerOpen, openExplorerWithDefaultTab, toggleFileExplorer]);

  const {
    translateX: explorerTranslateX,
    backdropOpacity: explorerBackdropOpacity,
    windowWidth: explorerWindowWidth,
    animateToOpen: animateExplorerToOpen,
    animateToClose: animateExplorerToClose,
    isGesturing: isExplorerGesturing,
  } = useExplorerSidebarAnimation();

  useEffect(() => {
    if (Platform.OS !== "web") {
      return;
    }
    const scope = `agent:${serverId}:${agentId ?? "unknown"}`;
    const stop = startPerfMonitor(scope);
    return stop;
  }, [serverId, agentId]);

  // Swipe-left gesture to open explorer sidebar on mobile
  const explorerOpenGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(isMobile && !isExplorerOpen)
        // Only activate after 15px horizontal movement to the left (negative)
        .activeOffsetX(-15)
        // Fail if 10px vertical movement happens first (allow vertical scroll)
        .failOffsetY([-10, 10])
        .onStart(() => {
          isExplorerGesturing.value = true;
        })
        .onUpdate((event) => {
          // Right sidebar: start from closed position (+windowWidth) and move towards 0
          // Swiping left means negative translationX
          const newTranslateX = Math.max(0, explorerWindowWidth + event.translationX);
          explorerTranslateX.value = newTranslateX;
          explorerBackdropOpacity.value = interpolate(
            newTranslateX,
            [explorerWindowWidth, 0],
            [0, 1],
            Extrapolation.CLAMP
          );
        })
        .onEnd((event) => {
          isExplorerGesturing.value = false;
          // Open if dragged more than 1/3 of window or fast swipe left
          const shouldOpen = event.translationX < -explorerWindowWidth / 3 || event.velocityX < -500;
          if (shouldOpen) {
            animateExplorerToOpen();
            runOnJS(openExplorerWithDefaultTab)();
          } else {
            animateExplorerToClose();
          }
        })
        .onFinalize(() => {
          isExplorerGesturing.value = false;
        }),
    [
      isMobile,
      isExplorerOpen,
      explorerWindowWidth,
      explorerTranslateX,
      explorerBackdropOpacity,
      animateExplorerToOpen,
      animateExplorerToClose,
      openExplorerWithDefaultTab,
      isExplorerGesturing,
    ]
  );

  // Handle hardware back button - close explorer sidebar first, then navigate back
  useEffect(() => {
    if (Platform.OS === "web") return;

    const handler = BackHandler.addEventListener("hardwareBackPress", () => {
      if (isExplorerOpen) {
        closeToAgent();
        return true; // Prevent default back navigation
      }
      return false; // Let default back navigation happen
    });

    return () => handler.remove();
  }, [isExplorerOpen, closeToAgent]);

  const resolvedAgentId = agentId;

  // Select only the specific agent
  const agent = useSessionStore((state) =>
    resolvedAgentId
      ? state.sessions[serverId]?.agents?.get(resolvedAgentId)
      : undefined
  );

  // Select only the specific stream tail - use stable empty array to avoid infinite loop
  const streamItemsRaw = useSessionStore((state) =>
    resolvedAgentId
      ? state.sessions[serverId]?.agentStreamTail?.get(resolvedAgentId)
      : undefined
  );
  const streamItems = streamItemsRaw ?? EMPTY_STREAM_ITEMS;

  const pendingCreate = useCreateFlowStore((state) => state.pending);
  const clearPendingCreate = useCreateFlowStore((state) => state.clear);
  const isPendingCreateForRoute =
    Boolean(pendingCreate) &&
    pendingCreate?.serverId === serverId &&
    pendingCreate?.agentId === resolvedAgentId;

  // Select only the specific initializing state
  const isInitializingFromMap = useSessionStore((state) =>
    resolvedAgentId
      ? state.sessions[serverId]?.initializingAgents?.get(resolvedAgentId) ?? false
      : false
  );
  const historySyncGeneration = useSessionStore(
    (state) => state.sessions[serverId]?.historySyncGeneration ?? 0
  );
  const agentHistorySyncGeneration = useSessionStore((state) =>
    resolvedAgentId
      ? state.sessions[serverId]?.agentHistorySyncGeneration?.get(resolvedAgentId) ?? -1
      : -1
  );

  // Select raw pending permissions - filter with useMemo to avoid new Map on every render
  const allPendingPermissions = useSessionStore(
    (state) => state.sessions[serverId]?.pendingPermissions
  );
  const pendingPermissions = useMemo(() => {
    if (!allPendingPermissions || !resolvedAgentId) return new Map();
    const filtered = new Map();
    for (const [key, perm] of allPendingPermissions) {
      if (perm.agentId === resolvedAgentId) {
        filtered.set(key, perm);
      }
    }
    return filtered;
  }, [allPendingPermissions, resolvedAgentId]);

  const client = useSessionStore(
    (state) => state.sessions[serverId]?.client ?? null
  );
  const isConnected = useSessionStore(
    (state) => state.sessions[serverId]?.connection.isConnected ?? false
  );
  const { ensureAgentIsInitialized, refreshAgent } = useAgentInitialization(serverId);
  const [missingAgentState, setMissingAgentState] = useState<MissingAgentState>({
    kind: "idle",
  });
  const [showReconnectNotice, setShowReconnectNotice] = useState(false);
  const [dismissedReconnectNotice, setDismissedReconnectNotice] = useState(false);
  const [showConnectedNotice, setShowConnectedNotice] = useState(false);
  const reconnectNoticeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectedNoticeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initAttemptTokenRef = useRef(0);
  const setFocusedAgentId = useCallback(
    (agentId: string | null) => {
      useSessionStore.getState().setFocusedAgentId(serverId, agentId);
    },
    [serverId]
  );

  const { height: keyboardHeight } = useReanimatedKeyboardAnimation();
  const bottomInset = useSharedValue(insets.bottom);

  useEffect(() => {
    bottomInset.value = insets.bottom;
  }, [insets.bottom, bottomInset]);

  const animatedKeyboardStyle = useAnimatedStyle(() => {
    "worklet";
    const absoluteHeight = Math.abs(keyboardHeight.value);
    const shift = Math.max(0, absoluteHeight - bottomInset.value);
    return {
      transform: [{ translateY: -shift }],
    };
  });

  const agentModel = extractAgentModel(agent);
  const modelDisplayValue = agentModel ?? "Unknown";

  useEffect(() => {
    if (reconnectNoticeTimeoutRef.current) {
      clearTimeout(reconnectNoticeTimeoutRef.current);
      reconnectNoticeTimeoutRef.current = null;
    }

    if (connectionStatus === "online") {
      if (showReconnectNotice || dismissedReconnectNotice) {
        setShowConnectedNotice(true);
      }
      setShowReconnectNotice(false);
      setDismissedReconnectNotice(false);
      return;
    }

    setShowConnectedNotice(false);
    if (!showReconnectNotice && !dismissedReconnectNotice) {
      reconnectNoticeTimeoutRef.current = setTimeout(() => {
        setShowReconnectNotice(true);
      }, RECONNECT_NOTICE_DELAY_MS);
    }

    return () => {
      if (reconnectNoticeTimeoutRef.current) {
        clearTimeout(reconnectNoticeTimeoutRef.current);
        reconnectNoticeTimeoutRef.current = null;
      }
    };
  }, [connectionStatus, dismissedReconnectNotice, showReconnectNotice]);

  useEffect(() => {
    if (!showConnectedNotice) {
      if (connectedNoticeTimeoutRef.current) {
        clearTimeout(connectedNoticeTimeoutRef.current);
        connectedNoticeTimeoutRef.current = null;
      }
      return;
    }
    connectedNoticeTimeoutRef.current = setTimeout(() => {
      setShowConnectedNotice(false);
      connectedNoticeTimeoutRef.current = null;
    }, CONNECTED_NOTICE_DURATION_MS);
    return () => {
      if (connectedNoticeTimeoutRef.current) {
        clearTimeout(connectedNoticeTimeoutRef.current);
        connectedNoticeTimeoutRef.current = null;
      }
    };
  }, [showConnectedNotice]);

  // Checkout status for header subtitle
  const checkoutStatusQuery = useCheckoutStatusQuery({
    serverId,
    cwd: agent?.cwd ?? "",
  });
  const checkout = checkoutStatusQuery.status;

  useEffect(() => {
    if (!resolvedAgentId) {
      setFocusedAgentId(null);
      return;
    }

    setFocusedAgentId(resolvedAgentId);
    return () => {
      setFocusedAgentId(null);
    };
  }, [resolvedAgentId, setFocusedAgentId]);

  const isInitializing = resolvedAgentId ? isInitializingFromMap !== false : false;
  const isHistorySyncing = useMemo(() => {
    if (!resolvedAgentId || !isInitializing) {
      return false;
    }
    const initKey = getInitKey(serverId, resolvedAgentId);
    return Boolean(getInitDeferred(initKey));
  }, [resolvedAgentId, isInitializing, serverId]);
  const needsAuthoritativeSync = useMemo(() => {
    if (!resolvedAgentId) {
      return false;
    }
    return agentHistorySyncGeneration < historySyncGeneration;
  }, [agentHistorySyncGeneration, historySyncGeneration, resolvedAgentId]);

  const optimisticStreamItems = useMemo<StreamItem[]>(() => {
    if (!isPendingCreateForRoute || !pendingCreate) {
      return EMPTY_STREAM_ITEMS;
    }
    return [
      {
        kind: "user_message",
        id: pendingCreate.messageId,
        text: pendingCreate.text,
        timestamp: new Date(pendingCreate.timestamp),
      },
    ];
  }, [isPendingCreateForRoute, pendingCreate]);

  const mergedStreamItems = useMemo<StreamItem[]>(() => {
    if (optimisticStreamItems.length === 0) {
      return streamItems;
    }
    const optimistic = optimisticStreamItems[0];
    if (!optimistic) {
      return streamItems;
    }
    const alreadyHasOptimistic = streamItems.some(
      (item) => item.kind === "user_message" && item.id === optimistic.id
    );
    return alreadyHasOptimistic ? streamItems : [...optimisticStreamItems, ...streamItems];
  }, [optimisticStreamItems, streamItems]);

  const shouldUseOptimisticStream = isPendingCreateForRoute && optimisticStreamItems.length > 0;
  const shouldBlockForHistorySync = !shouldUseOptimisticStream && (needsAuthoritativeSync || isHistorySyncing);

  const placeholderAgent: Agent | null = useMemo(() => {
    if (!shouldUseOptimisticStream || !resolvedAgentId) {
      return null;
    }
    const now = new Date();
    return {
      serverId,
      id: resolvedAgentId,
      provider: "claude",
      status: "running",
      createdAt: now,
      updatedAt: now,
      lastUserMessageAt: now,
      lastActivityAt: now,
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: false,
        supportsDynamicModes: false,
        supportsMcpServers: false,
        supportsReasoningStream: false,
        supportsToolInvocations: false,
      },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      runtimeInfo: {
        provider: "claude",
        sessionId: null,
        model: null,
        modeId: null,
      },
      title: "Agent",
      cwd: ".",
      model: null,
      labels: {},
    };
  }, [resolvedAgentId, serverId, shouldUseOptimisticStream]);

  const effectiveAgent = agent ?? placeholderAgent;
  const providerLabel = (effectiveAgent?.provider ?? "Provider").replace(/^\w/, (m) =>
    m.toUpperCase()
  );
  const providerSessionId =
    effectiveAgent?.runtimeInfo?.sessionId ?? effectiveAgent?.persistence?.sessionId ?? null;

  // Header subtitle: project path + branch (matching agent list row format)
  const headerProjectPath = effectiveAgent
    ? deriveProjectPath(effectiveAgent.cwd, checkout)
    : null;
  useEffect(() => {
    if (!isPendingCreateForRoute || !pendingCreate) {
      return;
    }
    const hasUserMessage = streamItems.some(
      (item) =>
        item.kind === "user_message" &&
        (item.id === pendingCreate.messageId || item.text === pendingCreate.text)
    );
    if (agent && hasUserMessage) {
      clearPendingCreate();
    }
  }, [
    agent,
    clearPendingCreate,
    isPendingCreateForRoute,
    pendingCreate,
    streamItems,
  ]);

  useEffect(() => {
    if (!resolvedAgentId || !ensureAgentIsInitialized) {
      return;
    }

    if (!isConnected) {
      return;
    }
    // On native clients, daemon stream forwarding is focused-agent only, so switching
    // agents can leave timeline gaps unless we explicitly request a snapshot.
    const shouldSyncOnEntry = needsAuthoritativeSync || Platform.OS !== "web";
    if (!shouldSyncOnEntry) {
      return;
    }

    ensureAgentIsInitialized(resolvedAgentId).catch((error) => {
      console.warn("[AgentScreen] Agent initialization failed", {
        agentId: resolvedAgentId,
        error,
      });
    });
  }, [
    resolvedAgentId,
    ensureAgentIsInitialized,
    isConnected,
    needsAuthoritativeSync,
  ]);

  useEffect(() => {
    // Clear stale resolution state when route target changes.
    initAttemptTokenRef.current += 1;
    setMissingAgentState({ kind: "idle" });
  }, [serverId, resolvedAgentId]);

  useEffect(() => {
    if (!resolvedAgentId || !ensureAgentIsInitialized) {
      return;
    }
    if (agent || shouldUseOptimisticStream) {
      if (missingAgentState.kind !== "idle") {
        setMissingAgentState({ kind: "idle" });
      }
      return;
    }
    if (!isConnected) {
      return;
    }
    if (missingAgentState.kind === "resolving" || missingAgentState.kind === "not_found") {
      return;
    }

    setMissingAgentState({ kind: "resolving" });
    const attemptToken = ++initAttemptTokenRef.current;

    ensureAgentIsInitialized(resolvedAgentId)
      .then(() => {
        if (attemptToken !== initAttemptTokenRef.current) {
          return;
        }
        setMissingAgentState({ kind: "idle" });
      })
      .catch((error) => {
        if (attemptToken !== initAttemptTokenRef.current) {
          return;
        }
        const message = toErrorMessage(error);
        if (isNotFoundErrorMessage(message)) {
          setMissingAgentState({ kind: "not_found", message });
          return;
        }
        setMissingAgentState({ kind: "error", message });
      });
  }, [
    agent,
    ensureAgentIsInitialized,
    isConnected,
    missingAgentState.kind,
    resolvedAgentId,
    shouldUseOptimisticStream,
  ]);

  useEffect(() => {
    if (Platform.OS !== "web") {
      return;
    }
    const title = agent?.title || "Agent";
    document.title = title;
  }, [agent?.title]);

  // Track previous agent status to detect completion while viewing
  const previousStatusRef = useRef<string | null>(null);

  // Clear attention when agent finishes while user is viewing this screen
  useEffect(() => {
    if (!resolvedAgentId || !agent || !client) {
      return;
    }

    const previousStatus = previousStatusRef.current;
    const currentStatus = agent.status;
    previousStatusRef.current = currentStatus;

    // If agent transitioned from running to idle while we're viewing,
    // immediately clear attention since user witnessed the completion
    if (previousStatus === "running" && currentStatus === "idle") {
      client.clearAgentAttention(resolvedAgentId);
    }
  }, [resolvedAgentId, agent?.status, client]);

  const handleRefreshAgent = useCallback(() => {
    if (!resolvedAgentId) {
      return;
    }
    void refreshAgent(resolvedAgentId).catch((error) => {
      console.warn("[AgentScreen] refreshAgent failed", { agentId: resolvedAgentId, error });
    });
  }, [resolvedAgentId, refreshAgent]);

  const handleCopyMeta = useCallback(
    async (label: string, value: string | null | undefined) => {
      if (!value) {
        return;
      }
      try {
        await Clipboard.setStringAsync(value);
        toast.show(`Copied ${label}`, {
          variant: "success",
          icon: <CheckCircle2 size={16} color={theme.colors.primary} />,
        });
      } catch {
        toast.error("Copy failed");
      }
    },
    [theme.colors.primary, toast]
  );

  if (!effectiveAgent) {
    if (missingAgentState.kind === "not_found") {
      return (
        <View style={styles.container} testID="agent-not-found">
          <MenuHeader title="Agent" />
          <View style={styles.errorContainer}>
            <Text style={styles.errorText}>Agent not found</Text>
          </View>
        </View>
      );
    }

    return (
      <View style={styles.container} testID="agent-loading">
        <MenuHeader title="Agent" />
        <View style={styles.errorContainer}>
          <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
        </View>
      </View>
    );
  }

  const mainContent = (
    <View style={styles.outerContainer}>
      <FileDropZone onFilesDropped={handleFilesDropped} disabled={isInitializing || shouldBlockForHistorySync}>
      <View style={styles.container}>
        {/* Header */}
        <MenuHeader
          title={effectiveAgent.title || "Agent"}
          rightContent={
            <View style={styles.headerRightContent}>
              <HeaderToggleButton
                onPress={handleToggleExplorer}
                tooltipLabel="Toggle explorer"
                tooltipKeys={["mod", "E"]}
                tooltipSide="left"
                style={styles.menuButton}
                accessible
                accessibilityRole="button"
                accessibilityLabel={isExplorerOpen ? "Close explorer" : "Open explorer"}
                accessibilityState={{ expanded: isExplorerOpen }}
              >
                {isMobile ? (
                  checkout?.isGit ? (
                    <GitBranch
                      size={20}
                      color={
                        isExplorerOpen
                          ? theme.colors.foreground
                          : theme.colors.foregroundMuted
                      }
                    />
                  ) : (
                    <Folder
                      size={20}
                      color={
                        isExplorerOpen
                          ? theme.colors.foreground
                          : theme.colors.foregroundMuted
                      }
                    />
                  )
                ) : (
                  <PanelRight
                    size={16}
                    color={
                      isExplorerOpen
                        ? theme.colors.foreground
                        : theme.colors.foregroundMuted
                    }
                  />
                )}
              </HeaderToggleButton>
              <DropdownMenu
                onOpenChange={(open) => {
                  if (open && agent?.cwd) {
                    checkoutStatusQuery.refresh().catch(() => {});
                  }
                }}
              >
                <DropdownMenuTrigger testID="agent-overflow-menu" style={styles.menuButton}>
                  <MoreVertical size={isMobile ? 20 : 16} color={theme.colors.foregroundMuted} />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" width={DROPDOWN_WIDTH} testID="agent-overflow-content">
                  <View style={styles.menuMetaContainer}>
                    <Pressable
                      style={({ hovered, pressed }) => [
                        styles.menuMetaRow,
                        (hovered || pressed) && styles.menuMetaRowActive,
                      ]}
                      onPress={() => {
                        void handleCopyMeta("Directory", effectiveAgent.cwd);
                      }}
                    >
                      <Text style={styles.menuMetaLabel} numberOfLines={1}>
                        Directory
                      </Text>
                      <Text
                        style={styles.menuMetaValue}
                        numberOfLines={1}
                        ellipsizeMode="middle"
                      >
                        {shortenPath(effectiveAgent.cwd)}
                      </Text>
                    </Pressable>

                    <Pressable
                      style={({ hovered, pressed }) => [
                        styles.menuMetaRow,
                        (hovered || pressed) && styles.menuMetaRowActive,
                      ]}
                      onPress={() => {
                        void handleCopyMeta("Model", modelDisplayValue);
                      }}
                    >
                      <Text style={styles.menuMetaLabel} numberOfLines={1}>
                        Model
                      </Text>
                      <Text
                        style={styles.menuMetaValue}
                        numberOfLines={1}
                        ellipsizeMode="middle"
                      >
                        {modelDisplayValue}
                      </Text>
                    </Pressable>

                    {checkout?.isGit && checkout.currentBranch && checkout.currentBranch !== "HEAD" ? (
                      <Pressable
                        style={({ hovered, pressed }) => [
                          styles.menuMetaRow,
                          (hovered || pressed) && styles.menuMetaRowActive,
                        ]}
                        onPress={() => {
                          if (checkoutStatusQuery.isFetching) {
                            return;
                          }
                          void handleCopyMeta("Branch", checkout.currentBranch);
                        }}
                      >
                        <Text style={styles.menuMetaLabel} numberOfLines={1}>
                          Branch
                        </Text>
                        <Text
                          style={styles.menuMetaValue}
                          numberOfLines={1}
                          ellipsizeMode="middle"
                        >
                          {checkoutStatusQuery.isFetching ? "Fetching…" : checkout.currentBranch}
                        </Text>
                      </Pressable>
                    ) : null}

                    <Pressable
                      style={({ hovered, pressed }) => [
                        styles.menuMetaRow,
                        (hovered || pressed) && styles.menuMetaRowActive,
                      ]}
                      onPress={() => {
                        void handleCopyMeta("Paseo ID", effectiveAgent.id);
                      }}
                    >
                      <Text style={styles.menuMetaLabel} numberOfLines={1}>
                        Paseo ID
                      </Text>
                      <Text
                        style={styles.menuMetaValue}
                        numberOfLines={1}
                        ellipsizeMode="middle"
                      >
                        {effectiveAgent.id}
                      </Text>
                    </Pressable>

                    <Pressable
                      style={({ hovered, pressed }) => [
                        styles.menuMetaRow,
                        providerSessionId && (hovered || pressed) && styles.menuMetaRowActive,
                      ]}
                      disabled={!providerSessionId}
                      onPress={() => {
                        void handleCopyMeta(`${providerLabel} ID`, providerSessionId);
                      }}
                    >
                      <Text style={styles.menuMetaLabel} numberOfLines={1}>
                        {providerLabel} ID
                      </Text>
                      <Text
                        style={[styles.menuMetaValue, !providerSessionId && styles.menuMetaValueError]}
                        numberOfLines={1}
                        ellipsizeMode="middle"
                      >
                        {providerSessionId ?? "Not available"}
                      </Text>
                    </Pressable>
                  </View>

                  <DropdownMenuSeparator />

                  <DropdownMenuItem
                    leading={<RotateCcw size={16} color={theme.colors.foreground} />}
                    disabled={isInitializing || shouldBlockForHistorySync}
                    trailing={
                      isInitializing ? (
                        <ActivityIndicator
                          size="small"
                          color={theme.colors.primary}
                          style={styles.menuItemSpinner}
                        />
                      ) : null
                    }
                    onSelect={handleRefreshAgent}
                  >
                    {isInitializing ? "Refreshing..." : "Refresh"}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </View>
          }
        />

          {(showReconnectNotice || showConnectedNotice) && (
            <View
              style={[
                styles.connectionNotice,
                showReconnectNotice
                  ? styles.connectionNoticeReconnecting
                  : styles.connectionNoticeConnected,
              ]}
            >
              {showConnectedNotice ? (
                <CheckCircle2
                  size={14}
                  color={theme.colors.palette.green[600]}
                />
              ) : null}
              <Text
                style={[
                  styles.connectionNoticeText,
                  showReconnectNotice
                    ? styles.connectionNoticeTextReconnecting
                    : styles.connectionNoticeTextConnected,
                ]}
              >
                {showReconnectNotice ? "Reconnecting..." : "Connected"}
              </Text>
              {showReconnectNotice ? (
                <Pressable
                  onPress={() => {
                    setShowReconnectNotice(false);
                    setDismissedReconnectNotice(true);
                  }}
                  style={styles.connectionNoticeDismiss}
                  accessibilityRole="button"
                  accessibilityLabel="Dismiss reconnecting notice"
                >
                  <Text style={styles.connectionNoticeDismissText}>Dismiss</Text>
                </Pressable>
              ) : null}
            </View>
          )}

          {/* Content Area with Keyboard Animation */}
          <View style={styles.contentContainer}>
            {shouldBlockForHistorySync ? (
              <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color={theme.colors.primary} />
              </View>
            ) : (
              <ReanimatedAnimated.View
                style={[styles.content, animatedKeyboardStyle]}
              >
                <AgentStreamView
                  agentId={effectiveAgent.id}
                  serverId={serverId}
                  agent={effectiveAgent}
                  streamItems={
                    shouldUseOptimisticStream ? mergedStreamItems : streamItems
                  }
                  pendingPermissions={pendingPermissions}
                />
              </ReanimatedAnimated.View>
            )}
          </View>

          {/* Agent Input Area */}
          {agent && resolvedAgentId && !shouldBlockForHistorySync && (
            <AgentInputArea
              agentId={resolvedAgentId}
              serverId={serverId}
              autoFocus
              onAddImages={handleAddImagesCallback}
            />
          )}

        </View>
      </FileDropZone>

        {/* Explorer Sidebar - Desktop: inline, Mobile: overlay */}
        {!isMobile && isExplorerOpen && resolvedAgentId && (
          <ExplorerSidebar serverId={serverId} agentId={resolvedAgentId} cwd={effectiveAgent.cwd} />
        )}
      </View>
  );

  return (
    <>
      {isMobile ? (
        <GestureDetector gesture={explorerOpenGesture} touchAction="pan-y">
          {mainContent}
        </GestureDetector>
      ) : (
        mainContent
      )}

      {/* Mobile Explorer Sidebar Overlay */}
      {isMobile && resolvedAgentId && (
        <ExplorerSidebar serverId={serverId} agentId={resolvedAgentId} cwd={effectiveAgent.cwd} />
      )}
    </>
  );
}

function AgentSessionUnavailableState({
  onBack,
  serverLabel,
  connectionStatus,
  lastError,
  isUnknownDaemon = false,
}: {
  onBack: () => void;
  serverLabel: string;
  connectionStatus: ConnectionStatus;
  lastError: string | null;
  isUnknownDaemon?: boolean;
}) {
  if (isUnknownDaemon) {
    return (
      <View style={styles.container}>
        <BackHeader title="Agent" onBack={onBack} />
        <View style={styles.centerState}>
          <Text style={styles.errorText}>
            Cannot open this agent because {serverLabel} is not configured on
            this device.
          </Text>
          <Text style={styles.statusText}>
            Add the host in Settings or open an agent on a configured server to
            continue.
          </Text>
        </View>
      </View>
    );
  }

  const isConnecting = connectionStatus === "connecting";

  return (
    <View style={styles.container}>
      <BackHeader title="Agent" onBack={onBack} />
      <View style={styles.centerState}>
        {isConnecting ? (
          <>
            <ActivityIndicator size="large" />
            <Text style={styles.loadingText}>
              Connecting to {serverLabel}...
            </Text>
            <Text style={styles.statusText}>
              We will show this agent once the host is online.
            </Text>
          </>
        ) : (
          <>
            <Text style={styles.offlineTitle}>
              Reconnecting to {serverLabel}...
            </Text>
            <Text style={styles.offlineDescription}>
              We will show this agent again as soon as the host is reachable.
            </Text>
            {lastError ? (
              <Text style={styles.offlineDetails}>{lastError}</Text>
            ) : null}
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  outerContainer: {
    flex: 1,
    flexDirection: "row",
    backgroundColor: theme.colors.surface0,
  },
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  headerRightContent: {
    flexDirection: "row",
    alignItems: "center",
  },
  contentContainer: {
    flex: 1,
    overflow: "hidden",
  },
  connectionNotice: {
    marginHorizontal: theme.spacing[4],
    marginTop: theme.spacing[1],
    marginBottom: theme.spacing[2],
    minHeight: 32,
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing[3],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  connectionNoticeReconnecting: {
    backgroundColor: `${theme.colors.palette.yellow[400]}22`,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.palette.yellow[400],
  },
  connectionNoticeConnected: {
    backgroundColor: theme.colors.palette.green[100],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.palette.green[400],
  },
  connectionNoticeText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  connectionNoticeTextReconnecting: {
    color: theme.colors.foreground,
  },
  connectionNoticeTextConnected: {
    color: theme.colors.palette.green[800],
  },
  connectionNoticeDismiss: {
    marginLeft: "auto",
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface0,
  },
  connectionNoticeDismissText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  content: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
  },
  loadingText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[6],
    gap: theme.spacing[3],
  },
  errorContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  errorText: {
    fontSize: theme.fontSize.lg,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
  statusText: {
    marginTop: theme.spacing[2],
    textAlign: "center",
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  errorDetails: {
    marginTop: theme.spacing[1],
    textAlign: "center",
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  offlineTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    textAlign: "center",
  },
  offlineDescription: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
  offlineDetails: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
  menuButton: {
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
  },
  menuMetaContainer: {
    paddingVertical: theme.spacing[1],
  },
  menuMetaRow: {
    minHeight: 32,
    paddingHorizontal: theme.spacing[3],
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  menuMetaRowActive: {
    backgroundColor: theme.colors.surface2,
  },
  menuMetaLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    flexShrink: 0,
  },
  menuMetaValue: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    flex: 1,
    minWidth: 0,
    textAlign: "right",
  },
  menuMetaValueError: {
    color: theme.colors.destructive,
  },
  menuItemSpinner: {
    marginLeft: "auto",
  },
}));
