import { useEffect, useMemo, useRef, useCallback, useState } from "react";
import {
  View,
  Text,
  ActivityIndicator,
  Pressable,
  Modal,
  useWindowDimensions,
  LayoutChangeEvent,
  ScrollView,
  Platform,
  BackHandler,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
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
  PlusIcon,
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

const DROPDOWN_WIDTH = 220;
const EMPTY_STREAM_ITEMS: StreamItem[] = [];


type BranchStatus = "idle" | "loading" | "ready" | "error";

export default function AgentScreen() {
  const router = useRouter();
  const { serverId, agentId } = useLocalSearchParams<{
    serverId: string;
    agentId: string;
  }>();
  const resolvedAgentId = typeof agentId === "string" ? agentId : undefined;
  const resolvedServerId = typeof serverId === "string" ? serverId : undefined;
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
    router.replace("/");
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
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();

  const [menuVisible, setMenuVisible] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 });
  const [menuContentHeight, setMenuContentHeight] = useState(0);
  const menuButtonRef = useRef<View>(null);
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

  // Select only the specific initializing state
  const isInitializingFromMap = useSessionStore((state) =>
    resolvedAgentId
      ? state.sessions[serverId]?.initializingAgents?.get(resolvedAgentId) ??
        false
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

  const isInitializing = resolvedAgentId
    ? isInitializingFromMap !== false
    : false;

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

  const recalculateMenuPosition = useCallback(
    (onMeasured?: () => void) => {
      requestAnimationFrame(() => {
        const anchor = menuButtonRef.current;

        if (!anchor) {
          if (onMeasured) {
            onMeasured();
          }
          return;
        }

        anchor.measureInWindow((x, y, width, height) => {
          const verticalOffset = 8;
          const horizontalMargin = 16;
          const desiredLeft = x + width - DROPDOWN_WIDTH;
          const maxLeft = windowWidth - DROPDOWN_WIDTH - horizontalMargin;
          const clampedLeft = Math.min(
            Math.max(desiredLeft, horizontalMargin),
            maxLeft
          );

          // Position menu below button using the raw coordinates from measureInWindow
          const buttonBottom = y + height;
          const top = buttonBottom + verticalOffset;

          // If menu would go off screen, clamp to visible area
          const bottomEdge = top + menuContentHeight;
          const maxBottom = windowHeight - horizontalMargin;
          const clampedTop =
            bottomEdge > maxBottom
              ? Math.max(verticalOffset, maxBottom - menuContentHeight)
              : top;

          setMenuPosition({
            top: clampedTop,
            left: clampedLeft,
          });

          if (onMeasured) {
            onMeasured();
          }
        });
      });
    },
    [menuContentHeight, windowHeight, windowWidth]
  );

  const handleOpenMenu = useCallback(() => {
    if (agent?.cwd) {
      refetchRepoInfo().catch(() => {});
    }

    recalculateMenuPosition(() => {
      setMenuVisible(true);
    });
  }, [agent?.cwd, recalculateMenuPosition, refetchRepoInfo]);

  const handleCloseMenu = useCallback(() => {
    setMenuVisible(false);
    setMenuContentHeight(0);
  }, []);

  useEffect(() => {
    if (!menuVisible) {
      return;
    }

    recalculateMenuPosition();
  }, [menuVisible, recalculateMenuPosition]);

  const handleMenuLayout = useCallback((event: LayoutChangeEvent) => {
    const { height } = event.nativeEvent.layout;
    setMenuContentHeight((current) => (current === height ? current : height));
  }, []);

  const handleViewChanges = useCallback(() => {
    handleCloseMenu();
    setExplorerTab("changes");
    openFileExplorer();
  }, [handleCloseMenu, setExplorerTab, openFileExplorer]);

  const handleBrowseFiles = useCallback(() => {
    handleCloseMenu();
    setExplorerTab("files");
    openFileExplorer();
  }, [handleCloseMenu, setExplorerTab, openFileExplorer]);

  const handleRefreshAgent = useCallback(() => {
    if (!resolvedAgentId || !refreshAgent) {
      return;
    }
    handleCloseMenu();
    refreshAgent({ agentId: resolvedAgentId });
  }, [handleCloseMenu, resolvedAgentId, refreshAgent]);

  const handleCreateNewAgent = useCallback(() => {
    if (!agent) {
      return;
    }
    handleCloseMenu();
    const params: Record<string, string> = { serverId };
    if (agent.cwd) {
      params.workingDir = agent.cwd;
    }
    if (agent.provider) {
      params.provider = agent.provider;
    }
    if (agent.currentModeId) {
      params.modeId = agent.currentModeId;
    }
    if (agentModel) {
      params.model = agentModel;
    }
    router.push({ pathname: "/", params });
  }, [agent, agentModel, handleCloseMenu, router, serverId]);

  if (!agent) {
    return (
      <View style={styles.container}>
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
          title={agent.title || "Agent"}
          rightContent={
            <View style={styles.headerRightContent}>
              <Pressable onPress={toggleFileExplorer} style={styles.menuButton}>
                {isMobile ? (
                  <Folder
                    size={16}
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
              <View ref={menuButtonRef} collapsable={false}>
                <Pressable testID="agent-overflow-menu" onPress={handleOpenMenu} style={styles.menuButton}>
                  <MoreVertical size={16} color={theme.colors.foregroundMuted} />
                </Pressable>
              </View>
            </View>
          }
        />

          {/* Content Area with Keyboard Animation */}
          <View style={styles.contentContainer}>
            <ReanimatedAnimated.View
              style={[styles.content, animatedKeyboardStyle]}
            >
              {isInitializing ? (
                <View style={styles.loadingContainer}>
                  <ActivityIndicator
                    size="large"
                    color={theme.colors.primary}
                  />
                  <Text style={styles.loadingText}>Loading agent...</Text>
                </View>
              ) : (
                <AgentStreamView
                  agentId={agent.id}
                  serverId={serverId}
                  agent={agent}
                  streamItems={streamItems}
                  pendingPermissions={pendingPermissions}
                />
              )}
            </ReanimatedAnimated.View>
          </View>

          {/* Agent Input Area */}
          {!isInitializing && agent && resolvedAgentId && (
            <AgentInputArea agentId={resolvedAgentId} serverId={serverId} autoFocus onAddImages={handleAddImagesCallback} />
          )}

        {/* Dropdown Menu */}
        <Modal
          visible={menuVisible}
          animationType="fade"
          transparent={true}
          onRequestClose={handleCloseMenu}
        >
          <View style={styles.menuOverlay}>
            <Pressable style={styles.menuBackdrop} onPress={handleCloseMenu} />
            <View
              style={[
                styles.dropdownMenu,
                {
                  position: "absolute",
                  top: menuPosition.top,
                  left: menuPosition.left,
                  width: DROPDOWN_WIDTH,
                },
              ]}
              onLayout={handleMenuLayout}
            >
              <View style={styles.menuMetaContainer}>
                <View style={styles.menuMetaRow}>
                  <Text style={styles.menuMetaLabel}>Directory</Text>
                  <Text
                    style={styles.menuMetaValue}
                    numberOfLines={2}
                    ellipsizeMode="middle"
                  >
                    {shortenPath(agent.cwd)}
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
                        <Text style={styles.menuMetaPendingText}>
                          Fetching…
                        </Text>
                      </>
                    ) : (
                      <Text
                        style={[
                          styles.menuMetaValue,
                          branchStatus === "error"
                            ? styles.menuMetaValueError
                            : null,
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

              <View style={styles.menuDivider} />

              <Pressable onPress={handleViewChanges} style={styles.menuItem}>
                <GitBranch size={16} color={theme.colors.foreground} />
                <Text style={styles.menuItemText}>View Changes</Text>
              </Pressable>
              <Pressable onPress={handleBrowseFiles} style={styles.menuItem}>
                <Folder size={16} color={theme.colors.foreground} />
                <Text style={styles.menuItemText}>Browse Files</Text>
              </Pressable>
              <Pressable onPress={handleCreateNewAgent} style={styles.menuItem}>
                <PlusIcon size={16} color={theme.colors.foreground} />
                <Text style={styles.menuItemText}>New Agent</Text>
              </Pressable>
              <Pressable
                onPress={handleRefreshAgent}
                style={[
                  styles.menuItem,
                  isInitializing ? styles.menuItemDisabled : null,
                ]}
                disabled={isInitializing}
              >
                <RotateCcw size={16} color={theme.colors.foreground} />
                <Text style={styles.menuItemText}>
                  {isInitializing ? "Refreshing..." : "Refresh"}
                </Text>
                {isInitializing && (
                  <ActivityIndicator
                    size="small"
                    color={theme.colors.primary}
                    style={styles.menuItemSpinner}
                  />
                )}
              </Pressable>
            </View>
          </View>
        </Modal>
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
  menuOverlay: {
    flex: 1,
  },
  menuBackdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  dropdownMenu: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[2],
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 5,
  },
  menuMetaContainer: {
    gap: theme.spacing[2],
    marginBottom: theme.spacing[2],
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
  menuDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.border,
    marginVertical: theme.spacing[2],
  },
  menuItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
  },
  menuItemDisabled: {
    opacity: 0.6,
  },
  menuItemSpinner: {
    marginLeft: "auto",
  },
  menuItemText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.normal,
  },
}));
