import {
  useState,
  useRef,
  useEffect,
  useMemo,
  useCallback,
} from "react";
import { createNameId } from "mnemonic-id";
import type { ReactElement, ReactNode } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  InteractionManager,
  Modal,
  useWindowDimensions,
  type LayoutChangeEvent,
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  Easing,
  runOnJS,
} from "react-native-reanimated";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { X } from "lucide-react-native";
import { theme as defaultTheme } from "@/styles/theme";
import { useRecentPaths } from "@/hooks/use-recent-paths";
import { useRouter } from "expo-router";
import { generateMessageId } from "@/types/stream";
import { MessageInput } from "./message-input";
import { useDaemonConnections, type ConnectionStatus } from "@/contexts/daemon-connections-context";
import type {
  AgentProvider,
  AgentSessionConfig,
} from "@server/server/agent/agent-sdk-types";
import { useDaemonRequest } from "@/hooks/use-daemon-request";
import type { WSInboundMessage, SessionOutboundMessage } from "@server/server/messages";
import { formatConnectionStatus } from "@/utils/daemons";
import { trackAnalyticsEvent } from "@/utils/analytics";
import type { SessionContextValue } from "@/contexts/session-context";
import type { UseWebSocketReturn } from "@/hooks/use-websocket";
import { useSessionStore, type Agent } from "@/stores/session-store";
import {
  AssistantDropdown,
  DropdownSheet,
  GitOptionsSection,
  ModelDropdown,
  PermissionsDropdown,
  WorkingDirectoryDropdown,
} from "@/components/agent-form/agent-form-dropdowns";
import {
  useAgentFormState,
  type CreateAgentInitialValues,
} from "@/hooks/use-agent-form-state";

interface AgentFlowModalProps {
  isVisible: boolean;
  onClose: () => void;
  initialValues?: CreateAgentInitialValues;
  serverId?: string | null;
  onAfterClose?: () => void;
}

interface ModalWrapperProps {
  isVisible: boolean;
  onClose: () => void;
  initialValues?: CreateAgentInitialValues;
  serverId?: string | null;
}

type CreateAgentSessionSlice = {
  serverId: string;
  ws: UseWebSocketReturn | null;
  createAgent: (options: {
    config: any;
    initialPrompt: string;
    git?: any;
    worktreeName?: string;
    requestId?: string;
  }) => void;
  sendAgentAudio: (
    agentId: string | undefined,
    audioBlob: Blob,
    requestId?: string,
    options?: { mode?: "transcribe_only" | "auto_run" }
  ) => Promise<void>;
  agents: Map<string, Agent>;
};

const BACKDROP_OPACITY = 0.55;
const IS_WEB = Platform.OS === "web";

type DropdownKey =
  | "assistant"
  | "permissions"
  | "model"
  | "workingDir"
  | "baseBranch"
  | "host";

type RepoInfoState = {
  cwd: string;
  repoRoot: string;
  branches: Array<{ name: string; isCurrent: boolean }>;
  currentBranch: string | null;
  isDirty: boolean;
};

type GitRepoInfoResponseMessage = Extract<
  SessionOutboundMessage,
  { type: "git_repo_info_response" }
>;

function AgentFlowModal({
  isVisible,
  onClose,
  initialValues,
  serverId,
  onAfterClose,
}: AgentFlowModalProps) {
  const insets = useSafeAreaInsets();
  const { height: screenHeight, width: screenWidth } = useWindowDimensions();
  const slideOffset = useSharedValue(screenHeight);
  const backdropOpacity = useSharedValue(0);
  const { height: keyboardHeight } = useReanimatedKeyboardAnimation();
  const shouldAutoFocusPrompt = IS_WEB;

  const { addRecentPath } = useRecentPaths();
  const { connectionStates } = useDaemonConnections();
  const daemonEntries = useMemo(() => Array.from(connectionStates.values()), [connectionStates]);
  const initialServerId = useMemo(() => {
    if (!serverId) {
      return null;
    }
    const exists = daemonEntries.some((entry) => entry.daemon.id === serverId);
    return exists ? serverId : null;
  }, [serverId, daemonEntries]);
  const {
    selectedServerId,
    setSelectedServerId,
    setSelectedServerIdFromUser,
    selectedProvider,
    setProviderFromUser,
    selectedMode,
    setModeFromUser,
    selectedModel,
    setModelFromUser,
    workingDir,
    setWorkingDirFromUser,
    providerDefinitions,
    providerDefinitionMap,
    modeOptions,
    availableModels,
    isModelLoading,
    modelError,
    refreshProviderModels,
    queueProviderModelFetch,
    clearQueuedProviderModelRequest,
    workingDirIsEmpty,
  } = useAgentFormState({
    initialServerId,
    initialValues,
    isVisible,
    isCreateFlow: true,
  });

  const sessionState = useSessionStore((state) =>
    selectedServerId ? state.sessions[selectedServerId] : undefined
  );

  // Extract only what we need for CreateAgentSessionSlice
  const session = useMemo<CreateAgentSessionSlice | null>(() => {
    if (!selectedServerId || !sessionState || !sessionState.methods) {
      return null;
    }
    const slice: CreateAgentSessionSlice = {
      serverId: selectedServerId,
      ws: sessionState.ws,
      createAgent: sessionState.methods.createAgent,
      sendAgentAudio: sessionState.methods.sendAgentAudio,
      agents: sessionState.agents,
    };
    return slice;
  }, [selectedServerId, sessionState]);

  useEffect(() => {
    if (selectedServerId) {
      const exists = daemonEntries.some((entry) => entry.daemon.id === selectedServerId);
      if (!exists) {
        setSelectedServerId(initialServerId);
      }
      return;
    }
    if (initialServerId && selectedServerId !== initialServerId) {
      setSelectedServerId(initialServerId);
    }
  }, [daemonEntries, selectedServerId, initialServerId]);

  useEffect(() => {
    if (!isVisible) {
      return;
    }
    if (initialServerId && selectedServerId !== initialServerId) {
      setSelectedServerId(initialServerId);
    }
  }, [isVisible, initialServerId, selectedServerId]);

  useEffect(() => {
    if (!isVisible || initialServerId || selectedServerId) {
      return;
    }
    const firstReady = daemonEntries.find(
      ({ status, sessionReady }) => status === "online" && sessionReady
    );
    if (firstReady) {
      setSelectedServerId(firstReady.daemon.id);
    }
  }, [daemonEntries, initialServerId, isVisible, selectedServerId]);

  const inertWebSocket = useMemo<UseWebSocketReturn>(
    () => ({
      isConnected: false,
      isConnecting: false,
      conversationId: null,
      lastError: null,
      send: () => {},
      on: () => () => {},
      sendPing: () => {},
      sendUserMessage: () => {},
      clearAgentAttention: () => {},
      subscribeConnectionStatus: () => () => {},
      getConnectionState: () => ({ isConnected: false, isConnecting: false }),
    }),
    []
  );
  const ws = session?.ws ?? null;
  const effectiveWs: UseWebSocketReturn = ws ?? inertWebSocket;
  const createAgent = session?.createAgent;
  const sessionSendAgentAudio = session?.sendAgentAudio;
  const noopSendAgentAudio = useCallback<SessionContextValue["sendAgentAudio"]>(async () => {}, []);
  const sendAgentAudio = sessionSendAgentAudio ?? noopSendAgentAudio;
  const hasSendAgentAudio = Boolean(sessionSendAgentAudio);
  const agents = session?.agents;
  const agentWorkingDirSuggestions = useMemo(() => {
    if (!selectedServerId || !agents) {
      return [];
    }
    const uniquePaths = new Set<string>();
    agents.forEach((agent) => {
      if (agent.cwd) {
        uniquePaths.add(agent.cwd);
      }
    });
    return Array.from(uniquePaths);
  }, [agents, selectedServerId]);
  const gitRepoInfoRequest = useDaemonRequest<
    { cwd: string },
    RepoInfoState,
    GitRepoInfoResponseMessage
  >({
    ws: effectiveWs,
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
      repoRoot: message.payload.repoRoot,
      branches: message.payload.branches ?? [],
      currentBranch: message.payload.currentBranch ?? null,
      isDirty: Boolean(message.payload.isDirty),
    }),
    extractError: (message) =>
      message.payload.error ? new Error(message.payload.error) : null,
    keepPreviousData: false,
  });
  const {
    status: repoRequestStatus,
    data: repoInfo,
    error: repoRequestError,
    execute: inspectRepoInfo,
    reset: resetRepoInfo,
    cancel: cancelRepoInfo,
  } = gitRepoInfoRequest;
  const isWsConnected = effectiveWs.getConnectionState
    ? effectiveWs.getConnectionState().isConnected
    : effectiveWs.isConnected;
  const router = useRouter();
  const sessionServerId = session?.serverId ?? null;
  const selectedDaemonId = selectedServerId ?? sessionServerId;
  const selectedDaemonConnection = selectedDaemonId
    ? connectionStates.get(selectedDaemonId)
    : null;
  const selectedDaemonStatus: ConnectionStatus =
    selectedDaemonConnection?.status ??
    (ws?.isConnected
      ? "online"
      : ws?.isConnecting
        ? "connecting"
        : ws?.lastError
          ? "error"
          : "offline");
  const selectedDaemonLabel =
    selectedDaemonConnection?.daemon.label ??
    selectedDaemonConnection?.daemon.wsUrl ??
    selectedDaemonId ??
    "Selected host";
  const selectedDaemonStatusLabel = formatConnectionStatus(selectedDaemonStatus);
  const hasSelectedDaemon = Boolean(selectedServerId);
  const selectedDaemonIsOffline = selectedDaemonStatus !== "online";
  const selectedDaemonLastError = selectedDaemonConnection?.lastError?.trim();
  const daemonAvailabilityError = !hasSelectedDaemon
    ? "Select a host before creating agents."
    : selectedDaemonIsOffline
        ? `${selectedDaemonLabel} is ${selectedDaemonStatusLabel}. We'll reconnect automatically and enable actions once it's online.${
            selectedDaemonLastError ? ` ${selectedDaemonLastError}` : ""
          }`
        : null;
  const selectedDaemonSessionReady =
    selectedDaemonConnection?.status === "online" &&
    selectedDaemonConnection.sessionReady;
  const isTargetDaemonReady = Boolean(
    hasSelectedDaemon && selectedDaemonSessionReady && !selectedDaemonIsOffline
  );

  const [isMounted, setIsMounted] = useState(isVisible);
  const [initialPrompt, setInitialPrompt] = useState("");
  const [useWorktree, setUseWorktree] = useState(false);
  const [baseBranch, setBaseBranch] = useState("");
  const [worktreeSlug, setWorktreeSlug] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [openDropdown, setOpenDropdown] = useState<DropdownKey | null>(null);
  const pendingRequestIdRef = useRef<string | null>(null);

  const hasPendingCreate = pendingRequestIdRef.current !== null;
  const shouldListenForStatus = isVisible || hasPendingCreate;

  const idleProviderPrefetchHandleRef = useRef<ReturnType<
    typeof InteractionManager.runAfterInteractions
  > | null>(null);
  const pendingNavigationAgentIdRef = useRef<string | null>(null);
  const pendingNavigationServerIdRef = useRef<string | null>(null);
  const openDropdownSheet = useCallback((key: DropdownKey) => {
    setOpenDropdown(key);
  }, []);
  const closeDropdown = useCallback(() => {
    setOpenDropdown(null);
  }, []);

  const handleUserWorkingDirChange = useCallback(
    (value: string) => {
      setWorkingDirFromUser(value);
      setErrorMessage("");
    },
    [setWorkingDirFromUser]
  );

  const logOfflineDaemonAction = useCallback(
    (action: "create" | "dictation", reason?: string | null) => {
      trackAnalyticsEvent({
        type: "offline_daemon_action_attempt",
        action,
        daemonId: selectedDaemonId,
        status: selectedDaemonStatus ?? null,
        reason: reason ?? daemonAvailabilityError,
      });
    },
    [
      daemonAvailabilityError,
      selectedDaemonId,
      selectedDaemonStatus,
    ]
  );

  const resetFormState = useCallback(() => {
    setInitialPrompt("");
    setUseWorktree(false);
    setBaseBranch("");
    setWorktreeSlug("");
    setErrorMessage("");
    setIsLoading(false);
    resetRepoInfo();
    setOpenDropdown(null);
    pendingRequestIdRef.current = null;
    pendingNavigationServerIdRef.current = null;
    cancelRepoInfo();
  }, [cancelRepoInfo, resetRepoInfo]);

  const navigateToAgentIfNeeded = useCallback(() => {
    const agentId = pendingNavigationAgentIdRef.current;
    const targetServerId = pendingNavigationServerIdRef.current ?? selectedDaemonId;
    if (!agentId || !targetServerId) {
      return;
    }

    pendingNavigationAgentIdRef.current = null;
    pendingNavigationServerIdRef.current = null;
    InteractionManager.runAfterInteractions(() => {
      router.push({
        pathname: "/agent/[serverId]/[agentId]",
        params: {
          serverId: targetServerId,
          agentId,
        },
      });
    });
  }, [router, selectedDaemonId]);

  const handleSelectServer = useCallback(
    (serverId: string) => {
      setSelectedServerIdFromUser(serverId);
    },
    [setSelectedServerIdFromUser]
  );

  const handleCloseAnimationComplete = useCallback(() => {
    console.log("[CreateAgentModal] close animation complete – resetting form");
    resetFormState();
    setIsMounted(false);
    navigateToAgentIfNeeded();
    onAfterClose?.();
  }, [navigateToAgentIfNeeded, onAfterClose, resetFormState]);

  useEffect(() => {
    if (!isVisible) {
      console.log(
        "[CreateAgentModal] visibility effect skipped (isVisible is false)",
        {
          isMounted,
        }
      );
      return;
    }

    console.log("[CreateAgentModal] visibility effect triggered", {
      wasMounted: isMounted,
      screenHeight,
    });
    setIsMounted(true);
    slideOffset.value = screenHeight;
    backdropOpacity.value = 0;

    backdropOpacity.value = withTiming(BACKDROP_OPACITY, {
      duration: 200,
      easing: Easing.out(Easing.cubic),
    });
    slideOffset.value = withTiming(0, {
      duration: 240,
      easing: Easing.out(Easing.cubic),
    });
  }, [isVisible, slideOffset, backdropOpacity, screenHeight]);

  useEffect(() => {
    if (!isMounted || isVisible) {
      console.log("[CreateAgentModal] close animation skipped", {
        isMounted,
        isVisible,
      });
      return;
    }

    console.log("[CreateAgentModal] close animation starting", {
      screenHeight,
    });
    backdropOpacity.value = withTiming(0, {
      duration: 160,
      easing: Easing.out(Easing.cubic),
    });
    slideOffset.value = withTiming(
      screenHeight,
      {
        duration: 220,
        easing: Easing.in(Easing.cubic),
      },
      (finished) => {
        if (finished) {
          console.log("[CreateAgentModal] slide animation finished");
          runOnJS(handleCloseAnimationComplete)();
        }
      }
    );
  }, [
    isMounted,
    isVisible,
    slideOffset,
    backdropOpacity,
    screenHeight,
    handleCloseAnimationComplete,
  ]);


  useEffect(() => {
    return () => {
      idleProviderPrefetchHandleRef.current?.cancel?.();
    };
  }, []);

  const footerAnimatedStyle = useAnimatedStyle(() => {
    "worklet";
    const absoluteHeight = Math.abs(keyboardHeight.value);
    const shift = Math.max(0, absoluteHeight - insets.bottom);
    return {
      transform: [{ translateY: -shift }],
    };
  }, [insets.bottom, keyboardHeight]);

  const containerAnimatedStyle = useAnimatedStyle(() => {
    "worklet";
    return {
      transform: [{ translateY: slideOffset.value }],
    };
  }, [slideOffset]);

  const backdropAnimatedStyle = useAnimatedStyle(() => {
    "worklet";
    return {
      opacity: backdropOpacity.value,
    };
  }, [backdropOpacity]);

  const handleUseWorktreeChange = useCallback((value: boolean) => {
    setUseWorktree(value);
    if (value && !worktreeSlug) {
      setWorktreeSlug(createNameId());
    }
  }, [worktreeSlug]);

  const validateWorktreeName = useCallback(
    (name: string): { valid: boolean; error?: string } => {
      if (!name) {
        return { valid: true };
      }

      if (name.length > 100) {
        return {
          valid: false,
          error: "Worktree name too long (max 100 characters)",
        };
      }

      if (!/^[a-z0-9-/]+$/.test(name)) {
        return {
          valid: false,
          error: "Must contain only lowercase letters, numbers, hyphens, and forward slashes",
        };
      }

      if (name.startsWith("-") || name.endsWith("-")) {
        return { valid: false, error: "Cannot start or end with a hyphen" };
      }

      if (name.includes("--")) {
        return { valid: false, error: "Cannot have consecutive hyphens" };
      }

      return { valid: true };
    },
    []
  );

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);


  useEffect(() => {
    idleProviderPrefetchHandleRef.current?.cancel?.();
    idleProviderPrefetchHandleRef.current = InteractionManager.runAfterInteractions(() => {
      daemonEntries.forEach(({ daemon, status }) => {
        const serverId = daemon.id;
        const isSelected = serverId === selectedServerId;
        const isReady = status === "online" || status === "idle";
        if (isSelected || !isReady) {
          clearQueuedProviderModelRequest(serverId);
          return;
        }
        queueProviderModelFetch(serverId, { delayMs: 320 });
      });
    });
    return () => {
      idleProviderPrefetchHandleRef.current?.cancel?.();
    };
  }, [
    clearQueuedProviderModelRequest,
    daemonEntries,
    queueProviderModelFetch,
    selectedProvider,
    selectedServerId,
  ]);

  const trimmedWorkingDir = workingDir.trim();
  const shouldInspectRepo = isVisible && trimmedWorkingDir.length > 0;
  const repoAvailabilityError = shouldInspectRepo && (!isTargetDaemonReady || !isWsConnected)
    ? daemonAvailabilityError ??
      "Repository details will load automatically once the selected host is back online."
    : null;
  const isNonGitDirectory =
    repoRequestStatus === "error" &&
    /not in a git repository/i.test(repoRequestError?.message ?? "");
  const repoInfoStatus: "idle" | "loading" | "ready" | "error" = !shouldInspectRepo
    ? "idle"
    : repoAvailabilityError
      ? "error"
      : repoRequestStatus === "loading"
        ? "loading"
        : repoRequestStatus === "error"
          ? isNonGitDirectory
            ? "idle"
            : "error"
          : repoRequestStatus === "success"
            ? "ready"
            : "idle";
  const repoInfoError = repoAvailabilityError ?? (isNonGitDirectory ? null : repoRequestError?.message ?? null);
  const gitHelperText = isNonGitDirectory
    ? "No git repository detected. Git options are disabled for this directory."
    : null;

  useEffect(() => {
    if (!shouldInspectRepo) {
      cancelRepoInfo();
      resetRepoInfo();
      return;
    }

    if (repoAvailabilityError) {
      cancelRepoInfo();
      return;
    }

    inspectRepoInfo({ cwd: trimmedWorkingDir }).catch(() => {});
    return () => {
      cancelRepoInfo();
    };
  }, [
    cancelRepoInfo,
    inspectRepoInfo,
    repoAvailabilityError,
    resetRepoInfo,
    shouldInspectRepo,
    trimmedWorkingDir,
  ]);

  useEffect(() => {
    if (isNonGitDirectory && useWorktree) {
      setUseWorktree(false);
    }
  }, [isNonGitDirectory, useWorktree]);

  const gitBlockingError = useMemo(() => {
    if (!useWorktree || isNonGitDirectory) {
      return null;
    }
    if (!worktreeSlug) {
      return null;
    }
    const validation = validateWorktreeName(worktreeSlug);
    if (!validation.valid) {
      return `Invalid worktree name: ${
        validation.error ?? "Must use lowercase letters, numbers, or hyphens"
      }`;
    }
    return null;
  }, [
    useWorktree,
    isNonGitDirectory,
    worktreeSlug,
    validateWorktreeName,
  ]);

  const baseBranchError = useMemo(() => {
    if (!useWorktree || isNonGitDirectory || !baseBranch) {
      return null;
    }
    const branches = repoInfo?.branches ?? [];
    if (branches.length === 0) {
      return null;
    }
    const branchExists = branches.some((b) => b.name === baseBranch);
    if (!branchExists) {
      return `Branch "${baseBranch}" not found in repository`;
    }
    return null;
  }, [useWorktree, isNonGitDirectory, baseBranch, repoInfo?.branches]);

  const handleBaseBranchChange = useCallback((value: string) => {
    setBaseBranch(value);
  }, []);

  const handleCreate = useCallback(async () => {
    const trimmedPath = workingDir.trim();
    if (!trimmedPath) {
      setErrorMessage("Working directory is required");
      return;
    }

    const trimmedPrompt = initialPrompt.trim();
    if (!trimmedPrompt) {
      setErrorMessage("Initial prompt is required");
      return;
    }

    if (isLoading) {
      return;
    }

    if (gitBlockingError) {
      setErrorMessage(gitBlockingError);
      return;
    }

    if (baseBranchError) {
      setErrorMessage(baseBranchError);
      return;
    }

    if (!createAgent || !isTargetDaemonReady) {
      logOfflineDaemonAction("create");
      setErrorMessage(
        daemonAvailabilityError ??
          "Creating agents is temporarily unavailable while the selected host is offline. Paseo reconnects automatically—try again once it's online."
      );
      return;
    }

    try {
      await addRecentPath(trimmedPath);
    } catch (error) {
      console.error("[CreateAgentModal] Failed to save recent path:", error);
    }

    const requestId = generateMessageId();

    pendingRequestIdRef.current = requestId;
    pendingNavigationServerIdRef.current = selectedDaemonId ?? null;
    setIsLoading(true);
    setErrorMessage("");

    const modeId =
      modeOptions.length > 0 && selectedMode !== "" ? selectedMode : undefined;
    const trimmedModel = selectedModel.trim();

    const config: AgentSessionConfig = {
      provider: selectedProvider,
      cwd: trimmedPath,
      ...(modeId ? { modeId } : {}),
      ...(trimmedModel ? { model: trimmedModel } : {}),
    };

    const effectiveBaseBranch = baseBranch.trim() || repoInfo?.currentBranch || undefined;
    const gitOptions = useWorktree && !isNonGitDirectory && worktreeSlug
      ? {
          createWorktree: true,
          worktreeSlug,
          baseBranch: effectiveBaseBranch,
        }
      : undefined;

    try {
      createAgent({
        config,
        initialPrompt: trimmedPrompt,
        git: gitOptions,
        requestId,
      });
    } catch (error) {
      console.error("[CreateAgentModal] Failed to create agent:", error);
      setErrorMessage("Failed to create agent. Please try again.");
      setIsLoading(false);
      pendingRequestIdRef.current = null;
      pendingNavigationServerIdRef.current = null;
    }
  }, [
    workingDir,
    initialPrompt,
    useWorktree,
    baseBranch,
    worktreeSlug,
    repoInfo?.currentBranch,
    selectedMode,
    modeOptions,
    logOfflineDaemonAction,
    selectedProvider,
    isLoading,
    addRecentPath,
    createAgent,
    daemonAvailabilityError,
    isTargetDaemonReady,
    selectedDaemonId,
    isNonGitDirectory,
    gitBlockingError,
    baseBranchError,
    selectedModel,
  ]);

  useEffect(() => {
    if (!shouldListenForStatus || !ws) {
      return;
    }
    const unsubscribe = ws.on("status", (message) => {
      if (message.type !== "status") {
        return;
      }

      const payload = message.payload as {
        status: string;
        agentId?: string;
        requestId?: string;
        error?: string;
      };

      if (payload.status === "agent_create_failed") {
        const expectedRequestId = pendingRequestIdRef.current;
        if (!expectedRequestId || payload.requestId !== expectedRequestId) {
          return;
        }
        pendingRequestIdRef.current = null;
        pendingNavigationServerIdRef.current = null;
        setIsLoading(false);
        setErrorMessage(
          payload.error ??
            "Failed to create agent. Resolve git issues or try again."
        );
        return;
      }

      if (payload.status !== "agent_created" || !payload.agentId) {
        return;
      }

      const expectedRequestId = pendingRequestIdRef.current;
      if (!expectedRequestId || payload.requestId !== expectedRequestId) {
        return;
      }

      console.log("[CreateAgentModal] Agent created:", payload.agentId);
      pendingRequestIdRef.current = null;
      setIsLoading(false);
      pendingNavigationAgentIdRef.current = payload.agentId;
      handleClose();
    });

    return () => {
      unsubscribe();
    };
  }, [handleClose, shouldListenForStatus, ws]);

  const shouldRender = isVisible || isMounted;

  const promptIsEmpty = !initialPrompt.trim();
  const createDisabled =
    workingDirIsEmpty ||
    promptIsEmpty ||
    Boolean(gitBlockingError) ||
    Boolean(baseBranchError) ||
    isLoading ||
    !isTargetDaemonReady;
  const headerPaddingTop = useMemo(
    () => insets.top + defaultTheme.spacing[4],
    [insets.top]
  );
  const horizontalPaddingLeft = useMemo(
    () => defaultTheme.spacing[6] + insets.left,
    [insets.left]
  );
  const horizontalPaddingRight = useMemo(
    () => defaultTheme.spacing[6] + insets.right,
    [insets.right]
  );

  const handleSheetLayout = useCallback((event: LayoutChangeEvent) => {
    const { height, y } = event.nativeEvent.layout;
    console.log("[CreateAgentModal] sheet layout", { height, y });
  }, []);

  if (!shouldRender) {
    // console.log("[CreateAgentModal] render skipped", {
    //   isVisible,
    //   isMounted,
    // });
    return null;
  }

  // console.log("[CreateAgentModal] rendering modal", {
  //   isVisible,
  //   isMounted,
  // });

  return (
    <Modal
      transparent
      statusBarTranslucent
      animationType="none"
      visible={shouldRender}
      onRequestClose={handleClose}
    >
      <View style={styles.overlay}>
        <Animated.View style={[styles.backdrop, backdropAnimatedStyle]}>
          <Pressable style={styles.backdropPressable} onPress={handleClose} />
        </Animated.View>
        <Animated.View
          style={[styles.sheet, containerAnimatedStyle]}
          onLayout={handleSheetLayout}
        >
          <View style={styles.content}>
            <ModalHeader
              paddingTop={headerPaddingTop}
              paddingLeft={horizontalPaddingLeft}
              paddingRight={horizontalPaddingRight}
              onClose={handleClose}
              title="Create New Agent"
            />
            <>
                <ScrollView
                  style={styles.scroll}
                  contentContainerStyle={[
                    styles.scrollContent,
                    {
                      paddingBottom: insets.bottom + defaultTheme.spacing[16],
                      paddingLeft: horizontalPaddingLeft,
                      paddingRight: horizontalPaddingRight,
                    },
                  ]}
                  keyboardShouldPersistTaps="handled"
                  showsVerticalScrollIndicator={false}
                >
                  <View style={styles.daemonSelectorSection}>
                    <Text style={styles.daemonSelectorLabel}>Target Host</Text>
                    {daemonEntries.length === 0 ? (
                      <Text style={styles.daemonChipText}>No hosts available</Text>
                    ) : (
                      <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={styles.daemonSelectorChips}
                      >
                        {daemonEntries.map(({ daemon, status }) => {
                          const isSelected = daemon.id === selectedServerId;
                          const label = daemon.label || daemon.wsUrl;
                          return (
                            <Pressable
                              key={daemon.id}
                              onPress={() => handleSelectServer(daemon.id)}
                              style={[styles.daemonChip, isSelected && styles.daemonChipSelected]}
                            >
                              <Text
                                style={[
                                  styles.daemonChipText,
                                  isSelected && styles.daemonChipTextSelected,
                                ]}
                                numberOfLines={1}
                              >
                                {label}
                              </Text>
                              <Text
                                style={[
                                  styles.daemonChipStatus,
                                  isSelected && styles.daemonChipTextSelected,
                                ]}
                              >
                                {formatConnectionStatus(status)}
                              </Text>
                            </Pressable>
                          );
                        })}
                      </ScrollView>
                    )}
                    {daemonAvailabilityError ? (
                      <Text style={styles.daemonAvailabilityText}>
                        {daemonAvailabilityError}
                      </Text>
                    ) : null}
                  </View>

                  <View style={styles.formSection}>
                    <Text style={styles.label}>Initial Prompt</Text>
                    <MessageInput
                      value={initialPrompt}
                      onChangeText={(text) => {
                        setInitialPrompt(text);
                        setErrorMessage("");
                      }}
                      onSubmit={() => {
                        void handleCreate();
                      }}
                      ws={effectiveWs}
                      sendAgentAudio={sendAgentAudio}
                      placeholder="Describe what you want the agent to do"
                      autoFocus={shouldAutoFocusPrompt}
                      disabled={isLoading || !isTargetDaemonReady}
                      isSubmitDisabled={createDisabled}
                    />
                  </View>

                  <WorkingDirectoryDropdown
                    workingDir={workingDir}
                    errorMessage={errorMessage}
                    disabled={isLoading}
                    suggestedPaths={agentWorkingDirSuggestions}
                    onSelectPath={handleUserWorkingDirChange}
                  />

                  <AssistantDropdown
                    providerDefinitions={providerDefinitions}
                    disabled={isLoading}
                    selectedProvider={selectedProvider}
                    onSelect={setProviderFromUser}
                  />

                  {!isNonGitDirectory ? (
                    <GitOptionsSection
                      useWorktree={useWorktree}
                      onUseWorktreeChange={handleUseWorktreeChange}
                      worktreeSlug={worktreeSlug}
                      currentBranch={repoInfo?.currentBranch ?? null}
                      baseBranch={baseBranch}
                      onBaseBranchChange={handleBaseBranchChange}
                      branches={repoInfo?.branches ?? []}
                      status={repoInfoStatus}
                      repoError={repoInfoError}
                      gitValidationError={gitBlockingError}
                      baseBranchError={baseBranchError}
                    />
                  ) : null}
                </ScrollView>

                <Animated.View
                  style={[
                    styles.footer,
                    {
                      paddingBottom: insets.bottom + defaultTheme.spacing[4],
                      paddingLeft: horizontalPaddingLeft,
                      paddingRight: horizontalPaddingRight,
                    },
                    footerAnimatedStyle,
                  ]}
                >
                  <Pressable
                    style={[
                      styles.createButton,
                      createDisabled && styles.createButtonDisabled,
                    ]}
                    onPress={handleCreate}
                    disabled={createDisabled}
                  >
                    {isLoading ? (
                      <View style={styles.loadingContainer}>
                        <ActivityIndicator
                          color={defaultTheme.colors.palette.white}
                        />
                        <Text style={styles.createButtonText}>Creating...</Text>
                      </View>
                    ) : (
                      <Text style={styles.createButtonText}>Create Agent</Text>
                    )}
                  </Pressable>
                </Animated.View>
              </>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

function LazyCreateAgentModal(props: Omit<AgentFlowModalProps, "onAfterClose">) {
  const { isVisible } = props;
  const [shouldRender, setShouldRender] = useState(isVisible);

  useEffect(() => {
    if (isVisible) {
      setShouldRender(true);
    }
  }, [isVisible]);

  const handleAfterClose = useCallback(() => {
    setShouldRender(false);
  }, []);

  if (!shouldRender) {
    return null;
  }

  return <AgentFlowModal {...props} onAfterClose={handleAfterClose} />;
}

export function CreateAgentModal(props: ModalWrapperProps) {
  return <LazyCreateAgentModal {...props} />;
}

interface ModalHeaderProps {
  paddingTop: number;
  paddingLeft: number;
  paddingRight: number;
  onClose: () => void;
  title: string;
  rightContent?: ReactNode;
}

function ModalHeader({
  paddingTop,
  paddingLeft,
  paddingRight,
  onClose,
  title,
  rightContent,
}: ModalHeaderProps): ReactElement {
  return (
    <View style={[styles.header, { paddingTop, paddingLeft, paddingRight }]}>
      <Text style={styles.headerTitle}>{title}</Text>
      <View style={styles.headerActions}>
        {rightContent}
        <Pressable onPress={onClose} style={styles.closeButton} hitSlop={8}>
          <X size={20} color={defaultTheme.colors.mutedForeground} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create(((theme: any) => ({
  overlay: {
    flex: 1,
    justifyContent: "flex-end",
  },
  backdrop: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: theme.colors.palette.gray[900],
    zIndex: 1,
  },
  backdropPressable: {
    flex: 1,
  },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    zIndex: 2,
    width: "100%",
    backgroundColor: theme.colors.card,
    overflow: "hidden",
  },
  content: {
    flex: 1,
    position: "relative",
  },
  header: {
    paddingBottom: theme.spacing[4],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize["2xl"],
    fontWeight: theme.fontWeight.semibold,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  closeButton: {
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingTop: theme.spacing[6],
    paddingBottom: theme.spacing[8],
    gap: theme.spacing[6],
  },
  formSection: {
    gap: theme.spacing[3],
  },
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  input: {
    backgroundColor: theme.colors.background,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  dropdownControl: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    backgroundColor: theme.colors.background,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  dropdownControlDisabled: {
    opacity: theme.opacity[50],
  },
  dropdownValue: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  dropdownPlaceholder: {
    flex: 1,
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.base,
  },
  dropdownSearchInput: {
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    color: theme.colors.foreground,
  },
  dropdownLoading: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  dropdownSheetOverlay: {
    flex: 1,
    justifyContent: "flex-end",
  },
  dropdownSheetBackdrop: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: theme.colors.palette.gray[900],
    opacity: 0.45,
  },
  dropdownSheetContainer: {
    backgroundColor: theme.colors.card,
    borderTopLeftRadius: theme.borderRadius["2xl"],
    borderTopRightRadius: theme.borderRadius["2xl"],
    paddingTop: theme.spacing[4],
    paddingHorizontal: theme.spacing[5],
    paddingBottom: theme.spacing[6] + theme.spacing[2],
    maxHeight: 560,
    width: "100%",
  },
  dropdownSheetHandle: {
    width: 56,
    height: 4,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.border,
    alignSelf: "center",
    marginBottom: theme.spacing[3],
  },
  dropdownSheetTitle: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    textAlign: "center",
    marginBottom: theme.spacing[4],
  },
  dropdownSheetScrollContent: {
    paddingBottom: theme.spacing[8],
    paddingHorizontal: theme.spacing[1],
  },
  dropdownSheetList: {
    marginTop: theme.spacing[3],
  },
  dropdownSheetOption: {
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
    marginBottom: theme.spacing[2],
  },
  dropdownSheetOptionSelected: {
    borderColor: theme.colors.palette.blue[400],
    backgroundColor: "rgba(59, 130, 246, 0.18)",
  },
  dropdownSheetOptionLabel: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.semibold,
  },
  dropdownSheetOptionDescription: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
  },
  dropdownSheetLoading: {
    alignItems: "center",
    paddingVertical: theme.spacing[4],
  },
  inputDisabled: {
    opacity: theme.opacity[50],
  },
  errorText: {
    color: theme.colors.palette.red[500],
    fontSize: theme.fontSize.sm,
  },
  warningText: {
    color: theme.colors.palette.orange[400],
    fontSize: theme.fontSize.sm,
  },
  helperText: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.sm,
  },
  selectorRow: {
    flexDirection: "row",
    gap: theme.spacing[4],
  },
  selectorRowStacked: {
    flexDirection: "column",
  },
  selectorColumn: {
    flex: 1,
    gap: theme.spacing[3],
  },
  selectorColumnFull: {
    width: "100%",
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  toggleRowDisabled: {
    opacity: theme.opacity[50],
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: theme.borderRadius.sm,
    borderWidth: theme.borderWidth[2],
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxChecked: {
    borderColor: theme.colors.palette.blue[500],
    backgroundColor: theme.colors.palette.blue[500],
  },
  checkboxDisabled: {
    borderColor: theme.colors.border,
  },
  checkboxDot: {
    width: 10,
    height: 10,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.palette.white,
  },
  toggleTextContainer: {
    flex: 1,
    gap: theme.spacing[1],
  },
  toggleLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  daemonSelectorSection: {
    marginBottom: theme.spacing[6],
  },
  daemonSelectorLabel: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: theme.spacing[2],
  },
  daemonSelectorChips: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  daemonChip: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    marginRight: theme.spacing[2],
  },
  daemonChipSelected: {
    backgroundColor: theme.colors.palette.blue[900],
    borderColor: theme.colors.palette.blue[500],
  },
  daemonChipText: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
  },
  daemonChipTextSelected: {
    color: theme.colors.palette.white,
  },
  daemonChipStatus: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.mutedForeground,
  },
  daemonAvailabilityText: {
    marginTop: theme.spacing[2],
    marginBottom: theme.spacing[2],
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
  footer: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing[4],
    backgroundColor: theme.colors.card,
  },
  createButton: {
    backgroundColor: theme.colors.palette.blue[500],
    paddingVertical: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
    alignItems: "center",
  },
  createButtonDisabled: {
    backgroundColor: theme.colors.palette.blue[900],
    opacity: theme.opacity[50],
  },
  createButtonText: {
    color: theme.colors.palette.white,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  loadingContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
})) as any) as Record<string, any>;
