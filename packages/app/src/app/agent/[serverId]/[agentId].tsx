import { useEffect, useMemo, useRef, useCallback, useState } from "react";
import {
  View,
  Text,
  ActivityIndicator,
  Pressable,
  Modal,
  useWindowDimensions,
  LayoutChangeEvent,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import ReanimatedAnimated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { MoreVertical, GitBranch, Folder, RotateCcw, PlusCircle, Download } from "lucide-react-native";
import { BackHeader } from "@/components/headers/back-header";
import { AgentStreamView } from "@/components/agent-stream-view";
import { AgentInputArea } from "@/components/agent-input-area";
import { CreateAgentModal, ImportAgentModal, type CreateAgentInitialValues } from "@/components/create-agent-modal";
import type { Agent, SessionContextValue } from "@/contexts/session-context";
import { useFooterControls } from "@/contexts/footer-controls-context";
import { useDaemonConnections } from "@/contexts/daemon-connections-context";
import type { ConnectionStatus } from "@/contexts/daemon-connections-context";
import { formatConnectionStatus } from "@/utils/daemons";
import { useDaemonSession } from "@/hooks/use-daemon-session";
import { useDaemonRequest } from "@/hooks/use-daemon-request";
import type { SessionOutboundMessage } from "@server/server/messages";

const DROPDOWN_WIDTH = 220;

type GitRepoInfoResponseMessage = Extract<
  SessionOutboundMessage,
  { type: "git_repo_info_response" }
>;

type BranchStatus = "idle" | "loading" | "ready" | "error";

function extractAgentModel(agent?: Agent | null): string | null {
  if (!agent) {
    return null;
  }

  const directModel = typeof agent.model === "string" ? agent.model.trim() : "";
  if (directModel.length > 0) {
    return directModel;
  }

  const metadata = agent.persistence?.metadata;
  if (!metadata || typeof metadata !== "object") {
    return null;
  }

  const persistedModel = (metadata as Record<string, unknown>).model;
  if (typeof persistedModel === "string" && persistedModel.trim().length > 0) {
    return persistedModel.trim();
  }

  const extra = (metadata as Record<string, unknown>).extra;
  if (!extra || typeof extra !== "object") {
    return null;
  }

  const getModelFrom = (source: unknown) => {
    if (!source || typeof source !== "object") {
      return null;
    }
    const candidate = (source as Record<string, unknown>).model;
    return typeof candidate === "string" && candidate.trim().length > 0
      ? candidate.trim()
      : null;
  };

  return (
    getModelFrom((extra as Record<string, unknown>).codex) ??
    getModelFrom((extra as Record<string, unknown>).claude)
  );
}

export default function AgentScreen() {
  const router = useRouter();
  const { serverId, agentId } = useLocalSearchParams<{ serverId: string; agentId: string }>();
  const resolvedAgentId = typeof agentId === "string" ? agentId : undefined;
  const resolvedServerId = typeof serverId === "string" ? serverId : undefined;
  const { connectionStates, activeDaemonId, setActiveDaemonId } = useDaemonConnections();
  const hasConnectionEntry = resolvedServerId ? connectionStates.has(resolvedServerId) : false;

  useEffect(() => {
    if (!resolvedServerId || !hasConnectionEntry) {
      return;
    }

    if (activeDaemonId === resolvedServerId) {
      return;
    }

    setActiveDaemonId(resolvedServerId, { source: "agent_route" });
  }, [resolvedServerId, hasConnectionEntry, activeDaemonId, setActiveDaemonId]);

  const session = useDaemonSession(resolvedServerId, {
    suppressUnavailableAlert: true,
    allowUnavailable: true,
  });

  const connectionServerId = resolvedServerId ?? null;
  const connection = connectionServerId ? connectionStates.get(connectionServerId) : null;
  const serverLabel = connection?.daemon.label ?? connectionServerId ?? "Selected host";
  const isUnknownDaemon = Boolean(connectionServerId && !connection);
  const connectionStatus = connection?.status ?? (isUnknownDaemon ? "offline" : "idle");
  const connectionStatusLabel = formatConnectionStatus(connectionStatus);
  const lastConnectionError = connection?.lastError ?? null;

  const handleBackToHome = useCallback(() => {
    router.replace("/");
  }, [router]);

  if (!session) {
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

  const routeServerId = resolvedServerId ?? session.serverId;

  return (
    <AgentScreenContent
      session={session}
      agentId={resolvedAgentId}
      routeServerId={routeServerId}
      onBack={handleBackToHome}
    />
  );
}

type AgentScreenContentProps = {
  session: SessionContextValue;
  agentId?: string;
  routeServerId: string;
  onBack: () => void;
};

function AgentScreenContent({ session, agentId, routeServerId, onBack }: AgentScreenContentProps) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { registerFooterControls, unregisterFooterControls } = useFooterControls();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [menuVisible, setMenuVisible] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 });
  const [menuContentHeight, setMenuContentHeight] = useState(0);
  const menuButtonRef = useRef<View>(null);
  const [showCreateAgentModal, setShowCreateAgentModal] = useState(false);
  const [showImportAgentModal, setShowImportAgentModal] = useState(false);
  const [createAgentInitialValues, setCreateAgentInitialValues] =
    useState<CreateAgentInitialValues | undefined>();

  const {
    agents,
    agentStreamState,
    initializingAgents,
    pendingPermissions,
    initializeAgent,
    refreshAgent,
    setFocusedAgentId,
    ws,
  } = session;
  const resolvedAgentId = agentId;

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

  const agent = resolvedAgentId ? agents.get(resolvedAgentId) : undefined;
  const streamItems = resolvedAgentId ? agentStreamState.get(resolvedAgentId) || [] : [];
  const agentPermissions = new Map(
    Array.from(pendingPermissions.entries()).filter(([_, perm]) => perm.agentId === resolvedAgentId)
  );
  const agentModel = extractAgentModel(agent);
  const modelDisplayValue = agentModel ?? "Unknown";

  const gitRepoInfoRequest = useDaemonRequest<
    { cwd: string },
    { cwd: string; currentBranch: string | null },
    GitRepoInfoResponseMessage
  >({
    ws,
    responseType: "git_repo_info_response",
    buildRequest: ({ params, requestId }) => ({
      type: "session",
      message: {
        type: "git_repo_info_request",
        cwd: params?.cwd ?? ".",
        requestId,
      },
    }),
    getRequestKey: (params) => params?.cwd ?? "default",
    selectData: (message) => ({
      cwd: message.payload.cwd,
      currentBranch: message.payload.currentBranch ?? null,
    }),
    extractError: (message) =>
      message.payload.error ? new Error(message.payload.error) : null,
    keepPreviousData: false,
  });
  const { execute: fetchGitRepoInfo, reset: resetGitRepoInfo } = gitRepoInfoRequest;
  const branchStatus: BranchStatus = !agent?.cwd
    ? "idle"
    : gitRepoInfoRequest.status === "loading"
      ? "loading"
      : gitRepoInfoRequest.status === "error"
        ? "error"
        : gitRepoInfoRequest.status === "success"
          ? "ready"
          : "idle";
  const branchLabel = gitRepoInfoRequest.data?.currentBranch ?? null;
  const branchError = gitRepoInfoRequest.error?.message ?? null;
  const branchDisplayValue =
    branchStatus === "error"
      ? branchError ?? "Unavailable"
      : branchLabel ?? "Unknown";

  useEffect(() => {
    if (!agent?.cwd) {
      resetGitRepoInfo();
      return;
    }
    fetchGitRepoInfo({ cwd: agent.cwd }).catch(() => {});
  }, [agent?.cwd, fetchGitRepoInfo, resetGitRepoInfo]);

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

  const hasStreamState = resolvedAgentId ? agentStreamState.has(resolvedAgentId) : false;
  const initializationState = resolvedAgentId ? initializingAgents.get(resolvedAgentId) : undefined;
  const isInitializing = resolvedAgentId
    ? initializationState !== undefined
      ? initializationState
      : !hasStreamState
    : false;

  useEffect(() => {
    if (!resolvedAgentId) {
      return;
    }

    if (initializationState !== undefined) {
      return;
    }

    if (hasStreamState) {
      return;
    }

    initializeAgent({ agentId: resolvedAgentId });
  }, [resolvedAgentId, initializeAgent, initializationState, hasStreamState]);

  const agentControls = useMemo(() => {
    if (!resolvedAgentId) return null;
    return <AgentInputArea agentId={resolvedAgentId} serverId={routeServerId} />;
  }, [resolvedAgentId, routeServerId]);

  useEffect(() => {
    if (!agentControls || !agent || isInitializing) {
      unregisterFooterControls();
      return;
    }

    registerFooterControls(agentControls);

    return () => {
      unregisterFooterControls();
    };
  }, [agentControls, agent, isInitializing, registerFooterControls, unregisterFooterControls]);

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
          const clampedLeft = Math.min(Math.max(desiredLeft, horizontalMargin), maxLeft);

          // Position menu below button using the raw coordinates from measureInWindow
          const buttonBottom = y + height;
          const top = buttonBottom + verticalOffset;

          // If menu would go off screen, clamp to visible area
          const bottomEdge = top + menuContentHeight;
          const maxBottom = windowHeight - horizontalMargin;
          const clampedTop = bottomEdge > maxBottom
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
      fetchGitRepoInfo({ cwd: agent.cwd }).catch(() => {});
    }

    recalculateMenuPosition(() => {
      setMenuVisible(true);
    });
  }, [agent?.cwd, fetchGitRepoInfo, recalculateMenuPosition]);

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
    if (resolvedAgentId) {
      router.push({
        pathname: "/git-diff",
        params: {
          agentId: resolvedAgentId,
          serverId: routeServerId,
        },
      });
    }
  }, [resolvedAgentId, routeServerId, router, handleCloseMenu]);

  const handleBrowseFiles = useCallback(() => {
    handleCloseMenu();
    if (resolvedAgentId) {
      router.push({
        pathname: "/file-explorer",
        params: {
          agentId: resolvedAgentId,
          serverId: routeServerId,
        },
      });
    }
  }, [handleCloseMenu, resolvedAgentId, routeServerId, router]);

  const handleRefreshAgent = useCallback(() => {
    if (!resolvedAgentId) {
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
    setCreateAgentInitialValues({
      workingDir: agent.cwd,
      provider: agent.provider,
      modeId: agent.currentModeId,
      model: agentModel ?? undefined,
    });
    setShowCreateAgentModal(true);
  }, [agent, agentModel, handleCloseMenu]);

  const handleCloseCreateAgentModal = useCallback(() => {
    setShowCreateAgentModal(false);
  }, []);

  const handleImportAgent = useCallback(() => {
    handleCloseMenu();
    setShowImportAgentModal(true);
  }, [handleCloseMenu]);

  const handleCloseImportAgentModal = useCallback(() => {
    setShowImportAgentModal(false);
  }, []);

  const createAgentModal = (
    <CreateAgentModal
      isVisible={showCreateAgentModal}
      onClose={handleCloseCreateAgentModal}
      initialValues={createAgentInitialValues}
      serverId={routeServerId}
    />
  );

  const importAgentModal = (
    <ImportAgentModal
      isVisible={showImportAgentModal}
      onClose={handleCloseImportAgentModal}
      serverId={routeServerId}
    />
  );

  if (!agent) {
    return (
      <>
        <View style={styles.container}>
          <BackHeader onBack={onBack} />
          <View style={styles.errorContainer}>
            <Text style={styles.errorText}>Agent not found</Text>
          </View>
        </View>
        {createAgentModal}
        {importAgentModal}
      </>
    );
  }

  return (
    <>
      <View style={styles.container}>
        {/* Header */}
        <BackHeader
          title={agent.title || "Agent"}
          onBack={onBack}
          rightContent={
            <View ref={menuButtonRef} collapsable={false}>
              <Pressable onPress={handleOpenMenu} style={styles.menuButton}>
                <MoreVertical size={20} color={theme.colors.foreground} />
              </Pressable>
            </View>
          }
        />

        {/* Content Area with Keyboard Animation */}
        <View style={styles.contentContainer}>
          <ReanimatedAnimated.View style={[styles.content, animatedKeyboardStyle]}>
            {isInitializing ? (
              <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color={theme.colors.primary} />
                <Text style={styles.loadingText}>Loading agent...</Text>
              </View>
            ) : (
              <AgentStreamView
                agentId={agent.id}
                serverId={routeServerId}
                agent={agent}
                streamItems={streamItems}
                pendingPermissions={agentPermissions}
              />
            )}
          </ReanimatedAnimated.View>
        </View>

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
                    {agent.cwd}
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
                          color={theme.colors.mutedForeground}
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

              <View style={styles.menuDivider} />

              <Pressable onPress={handleViewChanges} style={styles.menuItem}>
                <GitBranch size={20} color={theme.colors.foreground} />
                <Text style={styles.menuItemText}>View Changes</Text>
              </Pressable>
              <Pressable onPress={handleBrowseFiles} style={styles.menuItem}>
                <Folder size={20} color={theme.colors.foreground} />
                <Text style={styles.menuItemText}>Browse Files</Text>
              </Pressable>
              <Pressable onPress={handleImportAgent} style={styles.menuItem}>
                <Download size={20} color={theme.colors.foreground} />
                <Text style={styles.menuItemText}>Import Agent</Text>
              </Pressable>
              <Pressable onPress={handleCreateNewAgent} style={styles.menuItem}>
                <PlusCircle size={20} color={theme.colors.foreground} />
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
                <RotateCcw size={20} color={theme.colors.foreground} />
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
      {createAgentModal}
      {importAgentModal}
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
            Cannot open this agent because {serverLabel} is not configured on this device.
          </Text>
          <Text style={styles.statusText}>
            Add the daemon in Settings or open an agent on a configured server to continue.
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
            <Text style={styles.loadingText}>Connecting to {serverLabel}...</Text>
            <Text style={styles.statusText}>We will show this agent once the daemon is online.</Text>
          </>
        ) : (
          <>
            <Text style={styles.errorText}>
              Cannot open this agent while {serverLabel} is {connectionStatusLabel.toLowerCase()}.
            </Text>
            <Text style={styles.statusText}>
              Connect this daemon or switch to another one to continue.
            </Text>
            {lastError ? <Text style={styles.errorDetails}>{lastError}</Text> : null}
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
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
    color: theme.colors.mutedForeground,
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
    color: theme.colors.mutedForeground,
    textAlign: "center",
  },
  statusText: {
    marginTop: theme.spacing[2],
    textAlign: "center",
    fontSize: theme.fontSize.sm,
    color: theme.colors.mutedForeground,
  },
  errorDetails: {
    marginTop: theme.spacing[1],
    textAlign: "center",
    fontSize: theme.fontSize.xs,
    color: theme.colors.mutedForeground,
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
    backgroundColor: theme.colors.popover,
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
    color: theme.colors.mutedForeground,
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
    color: theme.colors.mutedForeground,
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
