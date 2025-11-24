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
import { MoreVertical, GitBranch, Folder, RotateCcw, PlusCircle } from "lucide-react-native";
import { BackHeader } from "@/components/headers/back-header";
import { AgentStreamView } from "@/components/agent-stream-view";
import { AgentInputArea } from "@/components/agent-input-area";
import { CreateAgentModal, type CreateAgentInitialValues } from "@/components/create-agent-modal";
import { useSession } from "@/contexts/session-context";
import type { Agent } from "@/contexts/session-context";
import { useFooterControls } from "@/contexts/footer-controls-context";
import { generateMessageId } from "@/types/stream";

const DROPDOWN_WIDTH = 220;

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
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const {
    agents,
    agentStreamState,
    initializingAgents,
    pendingPermissions,
    respondToPermission,
    initializeAgent,
    refreshAgent,
    setFocusedAgentId,
    ws,
  } = useSession();
  const { registerFooterControls, unregisterFooterControls } = useFooterControls();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [menuVisible, setMenuVisible] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 });
  const [menuContentHeight, setMenuContentHeight] = useState(0);
  const menuButtonRef = useRef<View>(null);
  const [branchStatus, setBranchStatus] = useState<BranchStatus>("idle");
  const [branchLabel, setBranchLabel] = useState<string | null>(null);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [showCreateAgentModal, setShowCreateAgentModal] = useState(false);
  const [createAgentInitialValues, setCreateAgentInitialValues] =
    useState<CreateAgentInitialValues | undefined>();
  const repoInfoRequestIdRef = useRef<string | null>(null);
  const hasPendingRepoRequest = repoInfoRequestIdRef.current !== null;
  const branchDisplayValue =
    branchStatus === "error"
      ? branchError ?? "Unavailable"
      : branchLabel ?? "Unknown";
  const shouldListenForBranchInfo = menuVisible || hasPendingRepoRequest;

  // Keyboard animation
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

  const agent = id ? agents.get(id) : undefined;
  const streamItems = id ? agentStreamState.get(id) || [] : [];
  const agentPermissions = new Map(
    Array.from(pendingPermissions.entries()).filter(([_, perm]) => perm.agentId === id)
  );
  const agentModel = extractAgentModel(agent);
  const modelDisplayValue = agentModel ?? "Unknown";

  const resetBranchState = useCallback(() => {
    repoInfoRequestIdRef.current = null;
    setBranchStatus("idle");
    setBranchLabel(null);
    setBranchError(null);
  }, []);

  const sendGitRepoInfoRequest = useCallback(
    (cwd: string) => {
      if (!cwd) {
        resetBranchState();
        return;
      }

      const requestId = generateMessageId();
      repoInfoRequestIdRef.current = requestId;
      setBranchStatus("loading");
      setBranchLabel(null);
      setBranchError(null);

      ws.send({
        type: "session",
        message: {
          type: "git_repo_info_request",
          cwd,
          requestId,
        },
      });
    },
    [resetBranchState, ws]
  );

  useEffect(() => {
    if (!agent?.cwd) {
      resetBranchState();
      return;
    }

    sendGitRepoInfoRequest(agent.cwd);
  }, [agent?.cwd, resetBranchState, sendGitRepoInfoRequest]);

  useEffect(() => {
    if (!shouldListenForBranchInfo) {
      return;
    }
    const unsubscribe = ws.on("git_repo_info_response", (message) => {
      if (message.type !== "git_repo_info_response") {
        return;
      }

      if (
        repoInfoRequestIdRef.current &&
        message.payload.requestId &&
        message.payload.requestId !== repoInfoRequestIdRef.current
      ) {
        return;
      }

      if (agent?.cwd && message.payload.cwd && message.payload.cwd !== agent.cwd) {
        return;
      }

      repoInfoRequestIdRef.current = null;

      if (message.payload.error) {
        setBranchStatus("error");
        setBranchError(message.payload.error);
        setBranchLabel(null);
        return;
      }

      setBranchStatus("ready");
      setBranchError(null);
      setBranchLabel(message.payload.currentBranch ?? null);
    });

    return () => {
      unsubscribe();
    };
  }, [agent?.cwd, shouldListenForBranchInfo, ws]);

  useEffect(() => {
    if (!id) {
      setFocusedAgentId(null);
      return;
    }

    setFocusedAgentId(id);
    return () => {
      setFocusedAgentId(null);
    };
  }, [id, setFocusedAgentId]);

  const hasStreamState = id ? agentStreamState.has(id) : false;
  const initializationState = id ? initializingAgents.get(id) : undefined;
  const isInitializing = id
    ? initializationState !== undefined
      ? initializationState
      : !hasStreamState
    : false;

  useEffect(() => {
    if (!id) {
      return;
    }

    if (initializationState !== undefined) {
      return;
    }

    if (hasStreamState) {
      return;
    }

    initializeAgent({ agentId: id });
  }, [id, initializeAgent, initializationState, hasStreamState]);

  const agentControls = useMemo(() => {
    if (!id) return null;
    return <AgentInputArea agentId={id} />;
  }, [id]);

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

          // Position menu below button - add insets.top to account for status bar
          const buttonBottom = y + height + insets.top;
          const top = buttonBottom + verticalOffset;
          
          // If menu would go off screen, clamp to visible area
          const bottomEdge = top + menuContentHeight;
          const maxBottom = windowHeight - horizontalMargin;
          const clampedTop = bottomEdge > maxBottom 
            ? Math.max(verticalOffset, maxBottom - menuContentHeight)
            : top;

          console.log('[Menu] Button position:', { x, y, width, height, insetsTop: insets.top });
          console.log('[Menu] Calculated position:', { buttonBottom, top, clampedTop, left: clampedLeft });

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
      sendGitRepoInfoRequest(agent.cwd);
    }

    recalculateMenuPosition(() => {
      setMenuVisible(true);
    });
  }, [agent?.cwd, recalculateMenuPosition, sendGitRepoInfoRequest]);

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

  const handleBackToHome = useCallback(() => {
    router.replace("/");
  }, [router]);

  const handleViewChanges = useCallback(() => {
    handleCloseMenu();
    if (id) {
      router.push(`/git-diff?agentId=${id}`);
    }
  }, [id, router, handleCloseMenu]);

  const handleBrowseFiles = useCallback(() => {
    handleCloseMenu();
    if (id) {
      router.push(`/file-explorer?agentId=${id}`);
    }
  }, [handleCloseMenu, id, router]);

  const handleRefreshAgent = useCallback(() => {
    if (!id) {
      return;
    }
    handleCloseMenu();
    refreshAgent({ agentId: id });
  }, [handleCloseMenu, id, refreshAgent]);

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

  const createAgentModal = (
    <CreateAgentModal
      isVisible={showCreateAgentModal}
      onClose={handleCloseCreateAgentModal}
      initialValues={createAgentInitialValues}
    />
  );


  if (!agent) {
    return (
      <>
        <View style={styles.container}>
          <BackHeader onBack={handleBackToHome} />
          <View style={styles.errorContainer}>
            <Text style={styles.errorText}>Agent not found</Text>
          </View>
        </View>
        {createAgentModal}
      </>
    );
  }

  return (
    <>
      <View style={styles.container}>
        {/* Header */}
        <BackHeader
          title={agent.title || "Agent"}
          onBack={handleBackToHome}
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
                agentId={id!}
                agent={agent}
                streamItems={streamItems}
                pendingPermissions={agentPermissions}
                onPermissionResponse={(agentId, requestId, response) =>
                  respondToPermission(agentId, requestId, response)
                }
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
    </>
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
  errorContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  errorText: {
    fontSize: theme.fontSize.lg,
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
