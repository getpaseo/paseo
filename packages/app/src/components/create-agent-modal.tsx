import {
  useState,
  useRef,
  useEffect,
  useMemo,
  useCallback,
} from "react";
import type { ReactElement, ReactNode } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  FlatList,
  ActivityIndicator,
  InteractionManager,
  TextInput,
  Modal,
  useWindowDimensions,
  type LayoutChangeEvent,
  type ListRenderItem,
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
import { Monitor, X } from "lucide-react-native";
import { theme as defaultTheme } from "@/styles/theme";
import { useRecentPaths } from "@/hooks/use-recent-paths";
import { useRouter } from "expo-router";
import { generateMessageId } from "@/types/stream";
import { MessageInput } from "./message-input";
import { useDaemonConnections, type ConnectionStatus } from "@/contexts/daemon-connections-context";
import type {
  AgentProvider,
  AgentSessionConfig,
  AgentPersistenceHandle,
  AgentTimelineItem,
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
  DropdownField,
  DropdownSheet,
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
  flow: "create" | "import";
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
  resumeAgent: (options: { handle: any; overrides?: any; requestId?: string }) => void;
  sendAgentAudio: (
    agentId: string | undefined,
    audioBlob: Blob,
    requestId?: string,
    options?: { mode?: "transcribe_only" | "auto_run" }
  ) => Promise<void>;
  agents: Map<string, Agent>;
};

const BACKDROP_OPACITY = 0.55;
const IMPORT_PAGE_SIZE = 20;
const IS_WEB = Platform.OS === "web";

type ImportCandidate = {
  provider: AgentProvider;
  sessionId: string;
  cwd: string;
  title: string;
  lastActivityAt: Date;
  persistence: AgentPersistenceHandle;
  timeline: AgentTimelineItem[];
};

type ProviderFilter = "all" | AgentProvider;
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

function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();
  if (!Number.isFinite(diffMs)) {
    return "unknown";
  }
  const minutes = Math.max(0, Math.floor(diffMs / 60000));
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function getImportPreview(candidate: ImportCandidate): string {
  for (const item of candidate.timeline) {
    if (item.type === "user_message") {
      const text = item.text.trim();
      if (text.length > 0) {
        return text;
      }
    }
  }
  return candidate.title || candidate.cwd;
}

function AgentFlowModal({
  isVisible,
  onClose,
  flow,
  initialValues,
  serverId,
  onAfterClose,
}: AgentFlowModalProps) {
  const insets = useSafeAreaInsets();
  const { height: screenHeight, width: screenWidth } = useWindowDimensions();
  const slideOffset = useSharedValue(screenHeight);
  const backdropOpacity = useSharedValue(0);
  const { height: keyboardHeight } = useReanimatedKeyboardAnimation();
  const isCompactLayout = screenWidth < 720;
  const shouldAutoFocusPrompt = IS_WEB;
  const isImportFlow = flow === "import";
  const isCreateFlow = !isImportFlow;

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
    isCreateFlow,
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
      resumeAgent: sessionState.methods.resumeAgent,
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
  const resumeAgent = session?.resumeAgent;
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
  const hostBadgeLabel = hasSelectedDaemon ? selectedDaemonLabel : "Select host";
  const selectedDaemonIsOffline = selectedDaemonStatus !== "online";
  const selectedDaemonLastError = selectedDaemonConnection?.lastError?.trim();
  const daemonAvailabilityError = !hasSelectedDaemon
    ? "Select a host before creating or importing agents."
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
  const [baseBranch, setBaseBranch] = useState("");
  const [createNewBranch, setCreateNewBranch] = useState(false);
  const [branchName, setBranchName] = useState("");
  const [createWorktree, setCreateWorktree] = useState(false);
  const [worktreeSlug, setWorktreeSlug] = useState("");
  const [branchNameEdited, setBranchNameEdited] = useState(false);
  const [worktreeSlugEdited, setWorktreeSlugEdited] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [importProviderFilter, setImportProviderFilter] =
    useState<ProviderFilter>("all");
  const [importSearchQuery, setImportSearchQuery] = useState("");
  const [importCandidates, setImportCandidates] = useState<ImportCandidate[]>(
    []
  );
  const [isImportLoading, setIsImportLoading] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [openDropdown, setOpenDropdown] = useState<DropdownKey | null>(null);
  const pendingRequestIdRef = useRef<string | null>(null);
  const shouldSyncBaseBranchRef = useRef(true);

  const hasPendingCreateOrResume = pendingRequestIdRef.current !== null;
  const shouldListenForStatus = isVisible || hasPendingCreateOrResume;

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

  const handleBaseBranchChange = useCallback(
    (value: string) => {
      shouldSyncBaseBranchRef.current = false;
      setBaseBranch(value);
      setErrorMessage("");
    },
    [setErrorMessage]
  );


  const providerFilterOptions = useMemo(
    () => [
      { id: "all" as ProviderFilter, label: "All" },
      ...providerDefinitions.map((definition) => ({
        id: definition.id as ProviderFilter,
        label: definition.label,
      })),
    ],
    []
  );
  const getProviderLabel = useCallback(
    (provider: AgentProvider) =>
      providerDefinitionMap.get(provider)?.label ?? provider,
    []
  );

  const activeSessionIds = useMemo(() => {
    const ids = new Set<string>();
    if (!agents) {
      return ids;
    }
    // Use persistence.sessionId for filtering - this is the canonical reference
    // to the provider's session file (Claude resume token, Codex thread ID, etc.)
    agents.forEach((agent) => {
      const persistedSessionId = agent.persistence?.sessionId;
      if (persistedSessionId) {
        ids.add(persistedSessionId);
      }
    });
    return ids;
  }, [agents]);
  const filteredImportCandidates = useMemo(() => {
    const providerFilter = importProviderFilter;
    const query = importSearchQuery.trim().toLowerCase();
    return importCandidates
      .filter((candidate) => !activeSessionIds.has(candidate.sessionId))
      .filter(
        (candidate) =>
          providerFilter === "all" || candidate.provider === providerFilter
      )
      .filter((candidate) => {
        if (query.length === 0) {
          return true;
        }
        const titleText = candidate.title.toLowerCase();
        const cwdText = candidate.cwd.toLowerCase();
        return titleText.includes(query) || cwdText.includes(query);
      })
      .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
  }, [
    activeSessionIds,
    importCandidates,
    importProviderFilter,
    importSearchQuery,
  ]);

  const logOfflineDaemonAction = useCallback(
    (action: "create" | "resume" | "dictation" | "import_list", reason?: string | null) => {
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
    setBaseBranch("");
    setCreateNewBranch(false);
    setBranchName("");
    setCreateWorktree(false);
    setWorktreeSlug("");
    setBranchNameEdited(false);
    setWorktreeSlugEdited(false);
    setErrorMessage("");
    setIsLoading(false);
    resetRepoInfo();
    setOpenDropdown(null);
    pendingRequestIdRef.current = null;
    pendingNavigationServerIdRef.current = null;
    shouldSyncBaseBranchRef.current = true;
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

  const requestImportCandidates = useCallback(
    (provider?: AgentProvider) => {
      if (!isTargetDaemonReady || !ws || !ws.isConnected) {
        setIsImportLoading(false);
        logOfflineDaemonAction("import_list");
        setImportError(
          daemonAvailabilityError ??
            "Import candidates load automatically once the selected host is back online."
        );
        return;
      }
      setIsImportLoading(true);
      setImportError(null);
      const msg: WSInboundMessage = {
        type: "session",
        message: {
          type: "list_persisted_agents_request",
          ...(provider ? { provider } : {}),
          limit: IMPORT_PAGE_SIZE,
        },
      };
      try {
        ws.send(msg);
      } catch (error) {
        console.error(
          "[CreateAgentModal] Failed to request persisted agents:",
          error
        );
        setIsImportLoading(false);
        setImportError("Unable to load agents to import. Please try again.");
      }
    },
    [daemonAvailabilityError, isTargetDaemonReady, logOfflineDaemonAction, ws]
  );

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

  const slugifyWorktreeName = useCallback((input: string): string => {
    return input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }, []);

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
    const slug = slugifyWorktreeName(initialPrompt);
    if (!branchNameEdited) {
      setBranchName(slug);
    }
    if (!worktreeSlugEdited) {
      setWorktreeSlug(slug);
    }
  }, [
    initialPrompt,
    branchNameEdited,
    worktreeSlugEdited,
    slugifyWorktreeName,
  ]);

  useEffect(() => {
    if (!isCreateFlow || !isVisible) {
      return;
    }
    shouldSyncBaseBranchRef.current = true;
  }, [isCreateFlow, isVisible, workingDir]);

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
  const shouldInspectRepo = isCreateFlow && isVisible && trimmedWorkingDir.length > 0;
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
    if (!repoInfo) {
      return;
    }
    setBaseBranch((prev) => {
      if (shouldSyncBaseBranchRef.current || prev.trim().length === 0) {
        shouldSyncBaseBranchRef.current = false;
        return repoInfo.currentBranch ?? "";
      }
      return prev;
    });
  }, [repoInfo]);

  useEffect(() => {
    if (!isNonGitDirectory) {
      return;
    }
    if (
      createNewBranch ||
      createWorktree ||
      baseBranch.trim().length > 0 ||
      branchName.trim().length > 0 ||
      worktreeSlug.trim().length > 0
    ) {
      setCreateNewBranch(false);
      setCreateWorktree(false);
      setBaseBranch("");
      setBranchName("");
      setWorktreeSlug("");
      setBranchNameEdited(false);
      setWorktreeSlugEdited(false);
      shouldSyncBaseBranchRef.current = true;
    }
  }, [
    baseBranch,
    branchName,
    createNewBranch,
    createWorktree,
    isNonGitDirectory,
    worktreeSlug,
  ]);

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

    if (!createAgent || !isTargetDaemonReady) {
      logOfflineDaemonAction("create");
      setErrorMessage(
        daemonAvailabilityError ??
          "Creating agents is temporarily unavailable while the selected host is offline. Paseo reconnects automatically—try again once it's online."
      );
      return;
    }

    const trimmedBaseBranch = baseBranch.trim();

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

    const currentBranch = repoInfo?.currentBranch ?? "";
    const shouldIncludeBase =
      createNewBranch ||
      createWorktree ||
      (trimmedBaseBranch.length > 0 && trimmedBaseBranch !== currentBranch);

    const gitOptions = shouldIncludeBase && !isNonGitDirectory
      ? {
          ...(trimmedBaseBranch ? { baseBranch: trimmedBaseBranch } : {}),
          ...(createNewBranch
            ? { createNewBranch: true, newBranchName: branchName.trim() }
            : {}),
          ...(createWorktree
            ? {
                createWorktree: true,
                worktreeSlug: (worktreeSlug || branchName).trim(),
              }
          : {}),
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
    baseBranch,
    createNewBranch,
    branchName,
    createWorktree,
    worktreeSlug,
    repoInfo,
    selectedMode,
    modeOptions,
    logOfflineDaemonAction,
    selectedProvider,
    isLoading,
    validateWorktreeName,
    addRecentPath,
    createAgent,
    daemonAvailabilityError,
    isTargetDaemonReady,
    selectedDaemonId,
  ]);

  const handleImportCandidatePress = useCallback(
    (candidate: ImportCandidate) => {
      if (isLoading) {
        return;
      }
      if (!resumeAgent || !isTargetDaemonReady) {
        logOfflineDaemonAction("resume");
        setImportError(
          daemonAvailabilityError ??
            "Importing agents will resume automatically once the selected host is online."
        );
        return;
      }
      setErrorMessage("");
      const requestId = generateMessageId();
      pendingRequestIdRef.current = requestId;
      pendingNavigationServerIdRef.current = selectedDaemonId ?? null;
      setIsLoading(true);
      resumeAgent({
        handle: candidate.persistence,
        requestId,
      });
    },
    [
      daemonAvailabilityError,
      isLoading,
      logOfflineDaemonAction,
      isTargetDaemonReady,
      resumeAgent,
      selectedDaemonId,
      setImportError,
    ]
  );

  const renderImportItem = useCallback<ListRenderItem<ImportCandidate>>(
    ({ item }) => (
      <Pressable
        onPress={() => handleImportCandidatePress(item)}
        disabled={isLoading || !isTargetDaemonReady}
        style={styles.resumeItem}
      >
        <View style={styles.resumeItemHeader}>
          <Text style={styles.resumeItemTitle} numberOfLines={1}>
            {getImportPreview(item)}
          </Text>
          <Text style={styles.resumeItemTimestamp}>
            {formatRelativeTime(item.lastActivityAt)}
          </Text>
        </View>
        <Text style={styles.resumeItemPath} numberOfLines={1}>
          {item.cwd}
        </Text>
        <View style={styles.resumeItemMetaRow}>
          <View style={styles.resumeProviderBadge}>
            <Text style={styles.resumeProviderBadgeText}>
              {getProviderLabel(item.provider)}
            </Text>
          </View>
          <Text style={styles.resumeItemHint}>Tap to import</Text>
        </View>
      </Pressable>
    ),
    [getProviderLabel, handleImportCandidatePress, isLoading, isTargetDaemonReady]
  );

  useEffect(() => {
    if (!isImportFlow || !isVisible || !ws) {
      return;
    }
    const unsubscribe = ws.on("list_persisted_agents_response", (message) => {
      if (message.type !== "list_persisted_agents_response") {
        return;
      }
      const mapped = message.payload.items.map((item) => ({
        provider: item.provider,
        sessionId: item.sessionId,
        cwd: item.cwd,
        title: item.title ?? `Session ${item.sessionId.slice(0, 8)}`,
        lastActivityAt: new Date(item.lastActivityAt),
        persistence: item.persistence,
        timeline: item.timeline ?? [],
      })) as ImportCandidate[];

      setImportCandidates(mapped);
      setIsImportLoading(false);
    });

    return () => {
      unsubscribe();
    };
  }, [isImportFlow, isVisible, ws]);

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

      if (
        (payload.status !== "agent_created" &&
          payload.status !== "agent_resumed") ||
        !payload.agentId
      ) {
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

  useEffect(() => {
    if (!isVisible || !isImportFlow) {
      return;
    }
    const provider =
      importProviderFilter === "all" ? undefined : importProviderFilter;
    requestImportCandidates(provider);
  }, [importProviderFilter, isImportFlow, isVisible, requestImportCandidates]);

  const refreshImportList = useCallback(() => {
    const provider =
      importProviderFilter === "all" ? undefined : importProviderFilter;
    requestImportCandidates(provider);
  }, [requestImportCandidates, importProviderFilter]);

  const shouldRender = isVisible || isMounted;
  const modalTitle = isImportFlow ? "Import Agent" : "Create New Agent";

  const gitBlockingError = useMemo(() => {
    if (isNonGitDirectory) {
      return null;
    }
    const trimmedBase = baseBranch.trim();
    const currentBranch = repoInfo?.currentBranch ?? "";
    const isCustomBase =
      trimmedBase.length > 0 &&
      (currentBranch.length === 0 || trimmedBase !== currentBranch);
    const requiresBase = createNewBranch || createWorktree || isCustomBase;

    if (requiresBase && !trimmedBase) {
      return "Select a base branch before launching the agent";
    }

    if (createNewBranch) {
      const slug = branchName.trim();
      const validation = validateWorktreeName(slug);
      if (!slug || !validation.valid) {
        return `Invalid branch name: ${
          validation.error ?? "Must use lowercase letters, numbers, hyphens, or forward slashes"
        }`;
      }
    }

    if (createWorktree) {
      const slug = (worktreeSlug || branchName).trim();
      const validation = validateWorktreeName(slug);
      if (!slug || !validation.valid) {
        return `Invalid worktree name: ${
          validation.error ?? "Must use lowercase letters, numbers, or hyphens"
        }`;
      }
    }

    if (!createWorktree && repoInfo?.isDirty) {
      const intendsCheckout =
        createNewBranch ||
        (trimmedBase.length > 0 && trimmedBase !== repoInfo.currentBranch);
      if (intendsCheckout) {
        return "Working directory has uncommitted changes. Clean up or create a worktree first.";
      }
    }

    return null;
  }, [
    baseBranch,
    branchName,
    createNewBranch,
    createWorktree,
    isNonGitDirectory,
    repoInfo,
    validateWorktreeName,
    worktreeSlug,
  ]);

  const promptIsEmpty = !initialPrompt.trim();
  const createDisabled =
    workingDirIsEmpty ||
    promptIsEmpty ||
    Boolean(gitBlockingError) ||
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
              title={modalTitle}
              rightContent={
                isImportFlow ? (
                  <Pressable
                    style={styles.hostBadge}
                    onPress={() => openDropdownSheet("host")}
                  >
                    <Monitor size={14} color={defaultTheme.colors.mutedForeground} />
                    <Text style={styles.hostBadgeLabel}>{hostBadgeLabel}</Text>
                    <View
                      style={[
                        styles.hostStatusDot,
                        selectedDaemonStatus === "online" && styles.hostStatusDotOnline,
                      ]}
                    />
                  </Pressable>
                ) : undefined
              }
            />
            {isCreateFlow ? (
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

                  <View
                    style={[
                      styles.selectorRow,
                      isCompactLayout && styles.selectorRowStacked,
                    ]}
                  >
                    <AssistantDropdown
                      providerDefinitions={providerDefinitions}
                      disabled={isLoading}
                      selectedProvider={selectedProvider}
                      isOpen={openDropdown === "assistant"}
                      onOpen={() => openDropdownSheet("assistant")}
                      onClose={closeDropdown}
                      onSelect={setProviderFromUser}
                    />
                    <PermissionsDropdown
                      disabled={isLoading}
                      modeOptions={modeOptions}
                      selectedMode={selectedMode}
                      isOpen={openDropdown === "permissions"}
                      onOpen={() => openDropdownSheet("permissions")}
                      onClose={closeDropdown}
                      onSelect={setModeFromUser}
                    />
                    <ModelDropdown
                      models={availableModels}
                      selectedModel={selectedModel}
                      isLoading={isModelLoading}
                      error={modelError}
                      isOpen={openDropdown === "model"}
                      onOpen={() => {
                        refreshProviderModels();
                        openDropdownSheet("model");
                      }}
                      onClose={closeDropdown}
                      onSelect={(modelId) => {
                        setModelFromUser(modelId);
                        setErrorMessage("");
                      }}
                      onClear={() => {
                        setModelFromUser("");
                        setErrorMessage("");
                      }}
                      onRefresh={refreshProviderModels}
                    />
                  </View>

                  <WorkingDirectoryDropdown
                    workingDir={workingDir}
                    errorMessage={errorMessage}
                    isOpen={openDropdown === "workingDir"}
                    onOpen={() => openDropdownSheet("workingDir")}
                    onClose={closeDropdown}
                    disabled={isLoading}
                    suggestedPaths={agentWorkingDirSuggestions}
                    onSelectPath={handleUserWorkingDirChange}
                  />

                  <GitOptionsSection
                    baseBranch={baseBranch}
                    onBaseBranchChange={handleBaseBranchChange}
                    branches={repoInfo?.branches ?? []}
                    status={repoInfoStatus}
                    repoError={repoInfoError}
                    helperText={gitHelperText}
                    isGitDisabled={Boolean(gitHelperText)}
                    warning={
                      !createWorktree && repoInfo?.isDirty
                        ? "Working directory has uncommitted changes"
                        : null
                    }
                    createNewBranch={createNewBranch}
                    onToggleCreateNewBranch={(next) => {
                      setCreateNewBranch(next);
                      if (next) {
                        if (!branchNameEdited) {
                          const slug = slugifyWorktreeName(
                            initialPrompt || baseBranch || ""
                          );
                          setBranchName(slug);
                        }
                      } else {
                        setBranchName("");
                        setBranchNameEdited(false);
                      }
                    }}
                    branchName={branchName}
                    onBranchNameChange={(value) => {
                      setBranchName(slugifyWorktreeName(value));
                      setBranchNameEdited(true);
                    }}
                    createWorktree={createWorktree}
                    onToggleCreateWorktree={(next) => {
                      setCreateWorktree(next);
                      if (next) {
                        if (!worktreeSlugEdited) {
                          const slug = slugifyWorktreeName(
                            initialPrompt || branchName || baseBranch || ""
                          );
                          setWorktreeSlug(slug);
                        }
                      } else {
                        setWorktreeSlug("");
                        setWorktreeSlugEdited(false);
                      }
                    }}
                    worktreeSlug={worktreeSlug}
                    onWorktreeSlugChange={(value) => {
                      setWorktreeSlug(slugifyWorktreeName(value));
                      setWorktreeSlugEdited(true);
                    }}
                    gitValidationError={gitBlockingError}
                    isBaseDropdownOpen={openDropdown === "baseBranch"}
                    onToggleBaseDropdown={() => openDropdownSheet("baseBranch")}
                    onCloseDropdown={closeDropdown}
                  />
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
            ) : (
              <View
                style={[
                  styles.resumeContainer,
                  {
                    paddingLeft: horizontalPaddingLeft,
                    paddingRight: horizontalPaddingRight,
                    paddingBottom: insets.bottom + defaultTheme.spacing[4],
                  },
                ]}
              >
                {daemonAvailabilityError ? (
                  <Text style={styles.daemonAvailabilityText}>
                    {daemonAvailabilityError}
                  </Text>
                ) : null}
                <View style={styles.resumeFilters}>
                  <View style={styles.providerFilterRow}>
                    {providerFilterOptions.map((option) => {
                      const isActive = importProviderFilter === option.id;
                      return (
                        <Pressable
                          key={option.id}
                          onPress={() => setImportProviderFilter(option.id)}
                          style={[
                            styles.providerFilterButton,
                            isActive && styles.providerFilterButtonActive,
                          ]}
                        >
                          <Text
                            style={[
                              styles.providerFilterText,
                              isActive && styles.providerFilterTextActive,
                            ]}
                          >
                            {option.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                  <View style={styles.resumeSearchRow}>
                    <TextInput
                      style={styles.resumeSearchInput}
                      placeholder="Search by title or path"
                      placeholderTextColor={defaultTheme.colors.mutedForeground}
                      value={importSearchQuery}
                      onChangeText={setImportSearchQuery}
                    />
                    <Pressable
                      style={styles.refreshButton}
                      onPress={refreshImportList}
                      disabled={isImportLoading || !isTargetDaemonReady}
                    >
                      <Text style={styles.refreshButtonText}>Refresh</Text>
                    </Pressable>
                  </View>
                </View>
                {importError ? (
                  <Text style={styles.importErrorText}>{importError}</Text>
                ) : null}
                {isImportLoading ? (
                  <View style={styles.resumeLoading}>
                    <ActivityIndicator
                      color={defaultTheme.colors.mutedForeground}
                    />
                    <Text style={styles.resumeLoadingText}>
                      Loading agents to import...
                    </Text>
                  </View>
                ) : filteredImportCandidates.length === 0 ? (
                  <View style={styles.resumeEmptyState}>
                    <Text style={styles.resumeEmptyTitle}>No agents to import</Text>
                    <Text style={styles.resumeEmptySubtitle}>
                      We will load the latest Claude and Codex sessions from your
                      local history so you can import them.
                    </Text>
                    <Pressable
                      style={styles.refreshButtonAlt}
                      onPress={refreshImportList}
                      disabled={isImportLoading || !isTargetDaemonReady}
                    >
                      <Text style={styles.refreshButtonAltText}>Try Again</Text>
                    </Pressable>
                  </View>
                ) : (
                  <FlatList
                    data={filteredImportCandidates}
                    renderItem={renderImportItem}
                    keyExtractor={(item) =>
                      `${item.provider}:${item.sessionId}`
                    }
                    ItemSeparatorComponent={() => (
                      <View style={styles.resumeItemSeparator} />
                    )}
                    showsVerticalScrollIndicator={false}
                    contentContainerStyle={styles.resumeListContent}
                  />
                )}
              </View>
            )}
            <DropdownSheet
              title="Host"
              visible={openDropdown === "host"}
              onClose={closeDropdown}
            >
              {daemonEntries.length === 0 ? (
                <Text style={styles.helperText}>No hosts available yet.</Text>
              ) : (
                <View style={styles.dropdownSheetList}>
                  {daemonEntries.map(({ daemon, status }) => {
                    const isSelected = daemon.id === selectedServerId;
                    const label = daemon.label ?? daemon.wsUrl ?? daemon.id;
                    return (
                      <Pressable
                        key={daemon.id}
                        style={[
                          styles.dropdownSheetOption,
                          isSelected && styles.dropdownSheetOptionSelected,
                        ]}
                        onPress={() => {
                          setSelectedServerIdFromUser(daemon.id);
                          closeDropdown();
                        }}
                      >
                        <Text style={styles.dropdownSheetOptionLabel}>{label}</Text>
                        <Text style={styles.dropdownSheetOptionDescription}>
                          {formatConnectionStatus(status)}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}
            </DropdownSheet>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

function LazyAgentFlowModal(props: Omit<AgentFlowModalProps, "onAfterClose">) {
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

export function ImportAgentModal(props: ModalWrapperProps) {
  return <LazyAgentFlowModal {...props} flow="import" />;
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

interface GitOptionsSectionProps {
  baseBranch: string;
  onBaseBranchChange: (value: string) => void;
  branches: Array<{ name: string; isCurrent: boolean }>;
  status: "idle" | "loading" | "ready" | "error";
  repoError: string | null;
  helperText?: string | null;
  warning: string | null;
  createNewBranch: boolean;
  onToggleCreateNewBranch: (value: boolean) => void;
  branchName: string;
  onBranchNameChange: (value: string) => void;
  createWorktree: boolean;
  onToggleCreateWorktree: (value: boolean) => void;
  worktreeSlug: string;
  onWorktreeSlugChange: (value: string) => void;
  gitValidationError: string | null;
  isGitDisabled?: boolean;
  isBaseDropdownOpen: boolean;
  onToggleBaseDropdown: () => void;
  onCloseDropdown: () => void;
}

function GitOptionsSection({
  baseBranch,
  onBaseBranchChange,
  branches,
  status,
  repoError,
  helperText,
  warning,
  createNewBranch,
  onToggleCreateNewBranch,
  branchName,
  onBranchNameChange,
  createWorktree,
  onToggleCreateWorktree,
  worktreeSlug,
  onWorktreeSlugChange,
  gitValidationError,
  isGitDisabled,
  isBaseDropdownOpen,
  onToggleBaseDropdown,
  onCloseDropdown,
}: GitOptionsSectionProps): ReactElement {
  const [branchSearch, setBranchSearch] = useState("");
  const branchFilter = branchSearch.trim().toLowerCase();
  const filteredBranches =
    branchFilter.length === 0
      ? branches
      : branches.filter((branch) =>
          branch.name.toLowerCase().includes(branchFilter)
        );
  const maxVisible = 30;
  const currentBranchLabel =
    branches.find((branch) => branch.isCurrent)?.name ?? "";
  const baseInputRef = useRef<TextInput | null>(null);
  const gitInputsDisabled = Boolean(isGitDisabled) || status === "loading";

  useEffect(() => {
    if (isBaseDropdownOpen) {
      setBranchSearch("");
      baseInputRef.current?.focus();
    }
  }, [isBaseDropdownOpen]);

  return (
    <View style={styles.formSection}>
      <Text style={styles.label}>Git Setup</Text>
      <Text style={styles.helperText}>
        Choose a base branch, then optionally create a feature branch or
        isolated worktree.
      </Text>

      <DropdownField
        label="Base Branch"
        value={baseBranch}
        placeholder={currentBranchLabel || "main"}
        onPress={onToggleBaseDropdown}
        disabled={gitInputsDisabled}
        errorMessage={repoError}
        warningMessage={!gitValidationError && !isGitDisabled ? warning : null}
        helperText={
          helperText ??
          (status === "loading"
            ? "Inspecting repository…"
            : "Search existing branches, then tap to select.")
        }
      />
      <DropdownSheet
        title="Base Branch"
        visible={isBaseDropdownOpen}
        onClose={onCloseDropdown}
      >
        <TextInput
          ref={baseInputRef}
          style={styles.dropdownSearchInput}
          placeholder={currentBranchLabel || "main"}
          placeholderTextColor={defaultTheme.colors.mutedForeground}
          value={branchSearch}
          onChangeText={setBranchSearch}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {status === "loading" ? (
          <View style={styles.dropdownLoading}>
            <ActivityIndicator color={defaultTheme.colors.mutedForeground} />
            <Text style={styles.helperText}>Inspecting repository…</Text>
          </View>
        ) : filteredBranches.length === 0 ? (
          <Text style={styles.helperText}>
            {branchFilter.length === 0
              ? "No branches detected yet."
              : "No branches match your search."}
          </Text>
        ) : (
          <View style={styles.dropdownSheetList}>
            {filteredBranches.slice(0, maxVisible).map((branch) => {
              const isActive = branch.name === baseBranch;
              return (
                <Pressable
                  key={branch.name}
                  style={[
                    styles.dropdownSheetOption,
                    isActive && styles.dropdownSheetOptionSelected,
                  ]}
                  onPress={() => {
                    onBaseBranchChange(branch.name);
                    onCloseDropdown();
                  }}
                >
                  <Text style={styles.dropdownSheetOptionLabel}>
                    {branch.name}
                    {branch.isCurrent ? "  (current)" : ""}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        )}
        {filteredBranches.length > maxVisible ? (
          <Text style={styles.helperText}>
            Showing first {maxVisible} matches. Keep typing to narrow it down.
          </Text>
        ) : null}
      </DropdownSheet>

      <ToggleRow
        label="New Branch"
        description="Create a feature branch before launching the agent"
        value={createNewBranch}
        onToggle={onToggleCreateNewBranch}
        disabled={isGitDisabled}
      />
      {createNewBranch ? (
        <TextInput
          style={styles.input}
          placeholder="feature-branch-name"
          placeholderTextColor={defaultTheme.colors.mutedForeground}
          value={branchName}
          onChangeText={onBranchNameChange}
          autoCapitalize="none"
          autoCorrect={false}
        />
      ) : null}

      <ToggleRow
        label="Create Worktree"
        description="Use an isolated directory so your current branch stays untouched"
        value={createWorktree}
        onToggle={onToggleCreateWorktree}
        disabled={isGitDisabled}
      />
      {createWorktree ? (
        <TextInput
          style={styles.input}
          placeholder={branchName || "feature-worktree"}
          placeholderTextColor={defaultTheme.colors.mutedForeground}
          value={worktreeSlug}
          onChangeText={onWorktreeSlugChange}
          autoCapitalize="none"
          autoCorrect={false}
        />
      ) : null}

      {gitValidationError ? (
        <Text style={styles.errorText}>{gitValidationError}</Text>
      ) : null}
    </View>
  );
}

interface ToggleRowProps {
  label: string;
  description?: string;
  value: boolean;
  onToggle: (value: boolean) => void;
  disabled?: boolean;
}

function ToggleRow({
  label,
  description,
  value,
  onToggle,
  disabled,
}: ToggleRowProps): ReactElement {
  return (
    <Pressable
      onPress={() => {
        if (!disabled) {
          onToggle(!value);
        }
      }}
      style={[styles.toggleRow, disabled && styles.toggleRowDisabled]}
    >
      <View
        style={[
          styles.checkbox,
          value && styles.checkboxChecked,
          disabled && styles.checkboxDisabled,
        ]}
      >
        {value ? <View style={styles.checkboxDot} /> : null}
      </View>
      <View style={styles.toggleTextContainer}>
        <Text style={styles.toggleLabel}>{label}</Text>
        {description ? (
          <Text style={styles.helperText}>{description}</Text>
        ) : null}
      </View>
    </Pressable>
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
  hostBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.muted,
    borderRadius: theme.borderRadius.full,
  },
  hostBadgeLabel: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
  },
  hostStatusDot: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.mutedForeground,
  },
  hostStatusDotOnline: {
    backgroundColor: theme.colors.palette.green[500],
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
  resumeContainer: {
    flex: 1,
    gap: theme.spacing[4],
  },
  resumeFilters: {
    gap: theme.spacing[3],
  },
  providerFilterRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  providerFilterButton: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
  providerFilterButtonActive: {
    borderColor: theme.colors.palette.blue[500],
    backgroundColor: theme.colors.muted,
  },
  providerFilterText: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  providerFilterTextActive: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.semibold,
  },
  resumeSearchRow: {
    flexDirection: "row",
    gap: theme.spacing[3],
    alignItems: "center",
  },
  resumeSearchInput: {
    flex: 1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    color: theme.colors.foreground,
  },
  refreshButton: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  refreshButtonText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  importErrorText: {
    color: theme.colors.palette.red[500],
    fontSize: theme.fontSize.sm,
  },
  resumeLoading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
  },
  resumeLoadingText: {
    color: theme.colors.mutedForeground,
  },
  resumeEmptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[6],
    textAlign: "center",
  },
  resumeEmptyTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
    textAlign: "center",
  },
  resumeEmptySubtitle: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  refreshButtonAlt: {
    marginTop: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.palette.blue[500],
    paddingHorizontal: theme.spacing[6],
    paddingVertical: theme.spacing[3],
  },
  refreshButtonAltText: {
    color: theme.colors.palette.white,
    fontWeight: theme.fontWeight.semibold,
  },
  resumeListContent: {
    paddingBottom: theme.spacing[8],
    gap: theme.spacing[2],
  },
  resumeItem: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[4],
    backgroundColor: theme.colors.background,
    gap: theme.spacing[2],
  },
  resumeItemHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  resumeItemTitle: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.semibold,
    flex: 1,
  },
  resumeItemTimestamp: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.sm,
  },
  resumeItemPath: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.sm,
  },
  resumeItemMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  resumeProviderBadge: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.muted,
  },
  resumeProviderBadgeText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
  },
  resumeItemHint: {
    color: theme.colors.mutedForeground,
    fontSize: theme.fontSize.xs,
  },
  resumeItemSeparator: {
    height: theme.spacing[2],
  },
})) as any) as Record<string, any>;
