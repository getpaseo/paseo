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
import { useFocusEffect } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import { useQuery } from "@tanstack/react-query";
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
} from "lucide-react-native";
import { MenuHeader } from "@/components/headers/menu-header";
import { BackHeader } from "@/components/headers/back-header";
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
import { formatConnectionStatus } from "@/utils/daemons";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const DROPDOWN_WIDTH = 220;
const EMPTY_STREAM_ITEMS: StreamItem[] = [];


type BranchStatus = "idle" | "loading" | "ready" | "error";

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
  const connectionStatusLabel = formatConnectionStatus(connectionStatus);
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
        connectionStatusLabel={connectionStatusLabel}
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
      />
    </ExplorerSidebarAnimationProvider>
  );
}

type AgentScreenContentProps = {
  serverId: string;
  agentId?: string;
};

function AgentScreenContent({
  serverId,
  agentId,
}: AgentScreenContentProps) {
  const { theme } = useUnistyles();
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
            runOnJS(openFileExplorer)();
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
      openFileExplorer,
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

  // Get methods
  const methods = useSessionStore((state) => state.sessions[serverId]?.methods);
  const refreshAgent = methods?.refreshAgent;
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

  const repoInfoQuery = useQuery({
    queryKey: ["gitRepoInfo", serverId, agent?.cwd ?? ""],
    queryFn: async () => {
      if (!client) {
        throw new Error("Daemon client unavailable");
      }
      const payload = await client.getGitRepoInfo({
        cwd: agent?.cwd ?? ".",
      });
      if (payload.error) {
        throw new Error(payload.error);
      }
      return {
        cwd: payload.cwd,
        currentBranch: payload.currentBranch ?? null,
      };
    },
    enabled: Boolean(client && isConnected && agent?.cwd),
    retry: false,
  });
  const { refetch: refetchRepoInfo } = repoInfoQuery;
  const branchStatus: BranchStatus = !agent?.cwd
    ? "idle"
    : repoInfoQuery.isPending || repoInfoQuery.isFetching
    ? "loading"
    : repoInfoQuery.isError
    ? "error"
    : repoInfoQuery.isSuccess
    ? "ready"
    : "idle";
  const branchLabel = repoInfoQuery.data?.currentBranch ?? null;
  const branchError = repoInfoQuery.error instanceof Error
    ? repoInfoQuery.error.message
    : null;
  const branchDisplayValue =
    branchStatus === "error"
      ? branchError ?? "Unavailable"
      : branchLabel ?? "Unknown";

  // Checkout status for header subtitle
  const checkoutStatusQuery = useCheckoutStatusQuery({
    serverId,
    agentId: resolvedAgentId ?? "",
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
    };
  }, [resolvedAgentId, serverId, shouldUseOptimisticStream]);

  const effectiveAgent = agent ?? placeholderAgent;

  // Header subtitle: project path + branch (matching agent list row format)
  const headerProjectPath = effectiveAgent
    ? deriveProjectPath(effectiveAgent.cwd, checkout)
    : null;
  const headerBranchLabel = deriveBranchLabel(checkout);
  const headerSubtitle = useMemo(() => {
    if (!headerProjectPath) return undefined;
    const path = shortenPath(headerProjectPath);
    if (headerBranchLabel) {
      return `${path} · ${headerBranchLabel}`;
    }
    return path;
  }, [headerProjectPath, headerBranchLabel]);

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

  // Get ensureAgentIsInitialized from methods
  const ensureAgentIsInitialized = methods?.ensureAgentIsInitialized;

  useEffect(() => {
    if (!resolvedAgentId || !ensureAgentIsInitialized) {
      return;
    }

    // Skip if not connected - will re-run when connection is established
    if (!isConnected) {
      return;
    }

    // ensureAgentIsInitialized handles deduplication via module-level promises map
    // If already initialized or in-flight, returns resolved/pending promise immediately
    ensureAgentIsInitialized(resolvedAgentId).catch((error) => {
      console.warn("[AgentScreen] Agent initialization failed", {
        agentId: resolvedAgentId,
        error,
      });
    });
  }, [resolvedAgentId, ensureAgentIsInitialized, isConnected]);

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

  const handleViewChanges = useCallback(() => {
    setExplorerTab("changes");
    openFileExplorer();
  }, [setExplorerTab, openFileExplorer]);

  const handleBrowseFiles = useCallback(() => {
    setExplorerTab("files");
    openFileExplorer();
  }, [setExplorerTab, openFileExplorer]);

  const handleRefreshAgent = useCallback(() => {
    if (!resolvedAgentId || !refreshAgent) {
      return;
    }
    refreshAgent({ agentId: resolvedAgentId });
  }, [resolvedAgentId, refreshAgent]);

  if (!effectiveAgent) {
    return (
      <View style={styles.container} testID="agent-not-found">
        <MenuHeader title="Agent" />
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>Agent not found</Text>
        </View>
      </View>
    );
  }

  const mainContent = (
    <View style={styles.outerContainer}>
      <FileDropZone onFilesDropped={handleFilesDropped} disabled={isInitializing}>
      <View style={styles.container}>
        {/* Header */}
        <MenuHeader
          title={effectiveAgent.title || "Agent"}
          subtitle={headerSubtitle}
          rightContent={
            <View style={styles.headerRightContent}>
              <Pressable onPress={toggleFileExplorer} style={styles.menuButton}>
                {isMobile ? (
                  <Folder
                    size={20}
                    color={
                      isExplorerOpen
                        ? theme.colors.foreground
                        : theme.colors.foregroundMuted
                    }
                  />
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
              </Pressable>
              <DropdownMenu
                onOpenChange={(open) => {
                  if (open && agent?.cwd) {
                    refetchRepoInfo().catch(() => {});
                  }
                }}
              >
                <DropdownMenuTrigger testID="agent-overflow-menu" style={styles.menuButton}>
                  <MoreVertical size={isMobile ? 20 : 16} color={theme.colors.foregroundMuted} />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" width={DROPDOWN_WIDTH} testID="agent-overflow-content">
                  <View style={styles.menuMetaContainer}>
                    <View style={styles.menuMetaRow}>
                      <Text style={styles.menuMetaLabel}>Directory</Text>
                      <Text
                        style={styles.menuMetaValue}
                        numberOfLines={2}
                        ellipsizeMode="middle"
                      >
                        {shortenPath(effectiveAgent.cwd)}
                      </Text>
                    </View>

                    <View style={styles.menuMetaRow}>
                      <Text style={styles.menuMetaLabel}>Model</Text>
                      <Text
                        style={styles.menuMetaValue}
                        numberOfLines={1}
                        ellipsizeMode="middle"
                      >
                        {modelDisplayValue}
                      </Text>
                    </View>

                    <View style={styles.menuMetaRow}>
                      <Text style={styles.menuMetaLabel}>Branch</Text>
                      <View style={styles.menuMetaValueRow}>
                        {branchStatus === "loading" ? (
                          <>
                            <ActivityIndicator
                              size="small"
                              color={theme.colors.foregroundMuted}
                            />
                            <Text style={styles.menuMetaPendingText}>Fetching…</Text>
                          </>
                        ) : (
                          <Text
                            style={[
                              styles.menuMetaValue,
                              branchStatus === "error" ? styles.menuMetaValueError : null,
                            ]}
                            numberOfLines={1}
                            ellipsizeMode="middle"
                          >
                            {branchDisplayValue}
                          </Text>
                        )}
                      </View>
                    </View>
                  </View>

                  <DropdownMenuSeparator />

                  <DropdownMenuItem
                    leading={<GitBranch size={16} color={theme.colors.foreground} />}
                    onSelect={handleViewChanges}
                  >
                    View Changes
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    leading={<Folder size={16} color={theme.colors.foreground} />}
                    onSelect={handleBrowseFiles}
                  >
                    Browse Files
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    leading={<RotateCcw size={16} color={theme.colors.foreground} />}
                    disabled={isInitializing}
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

          {/* Content Area with Keyboard Animation */}
          <View style={styles.contentContainer}>
            <ReanimatedAnimated.View
              style={[styles.content, animatedKeyboardStyle]}
            >
              {isInitializing && !shouldUseOptimisticStream ? (
                <View style={styles.loadingContainer}>
                  <ActivityIndicator
                    size="large"
                    color={theme.colors.primary}
                  />
                  <Text style={styles.loadingText}>Loading agent...</Text>
                </View>
              ) : (
                <AgentStreamView
                  agentId={effectiveAgent.id}
                  serverId={serverId}
                  agent={effectiveAgent}
                  streamItems={shouldUseOptimisticStream ? mergedStreamItems : streamItems}
                  pendingPermissions={pendingPermissions}
                />
              )}
            </ReanimatedAnimated.View>
          </View>

          {/* Agent Input Area */}
          {!isInitializing && agent && resolvedAgentId && (
            <AgentInputArea agentId={resolvedAgentId} serverId={serverId} autoFocus onAddImages={handleAddImagesCallback} />
          )}

        </View>
      </FileDropZone>

        {/* Explorer Sidebar - Desktop: inline, Mobile: overlay */}
        {!isMobile && isExplorerOpen && resolvedAgentId && (
          <ExplorerSidebar serverId={serverId} agentId={resolvedAgentId} />
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
        <ExplorerSidebar serverId={serverId} agentId={resolvedAgentId} />
      )}
    </>
  );
}

function AgentSessionUnavailableState({
  onBack,
  serverLabel,
  connectionStatus,
  connectionStatusLabel,
  lastError,
  isUnknownDaemon = false,
}: {
  onBack: () => void;
  serverLabel: string;
  connectionStatus: ConnectionStatus;
  connectionStatusLabel: string;
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
              {serverLabel} is currently {connectionStatusLabel.toLowerCase()}.
            </Text>
            <Text style={styles.offlineDescription}>
              We'll reconnect automatically and show this agent as soon as the
              host comes back online.
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
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[2],
  },
  menuMetaRow: {
    gap: theme.spacing[1],
  },
  menuMetaLabel: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  menuMetaValue: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  menuMetaValueRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  menuMetaPendingText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  menuMetaValueError: {
    color: theme.colors.destructive,
  },
  menuItemSpinner: {
    marginLeft: "auto",
  },
}));
