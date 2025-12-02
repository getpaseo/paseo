import {
  useState,
  useRef,
  useEffect,
  useMemo,
  useCallback,
  useLayoutEffect,
} from "react";
import type { ReactElement, RefObject, ReactNode } from "react";
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
  NativeSyntheticEvent,
  TextInputContentSizeChangeEventData,
  TextInputKeyPressEventData,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
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
import { Mic, Check, X, ChevronDown, RefreshCcw } from "lucide-react-native";
import { theme as defaultTheme } from "@/styles/theme";
import { useRecentPaths } from "@/hooks/use-recent-paths";
import { useRouter } from "expo-router";
import { generateMessageId } from "@/types/stream";
import { useDictation } from "@/hooks/use-dictation";
import type { DictationStatus } from "@/hooks/use-dictation";
import { VolumeMeter } from "@/components/volume-meter";
import { AUDIO_DEBUG_ENABLED } from "@/config/audio-debug";
import { AudioDebugNotice, type AudioDebugInfo } from "./audio-debug-notice";
import { DictationStatusNotice, type DictationToastVariant } from "./dictation-status-notice";
import {
  AGENT_PROVIDER_DEFINITIONS,
  type AgentProviderDefinition,
} from "@server/server/agent/provider-manifest";
import { useDaemonConnections, type ConnectionStatus } from "@/contexts/daemon-connections-context";
import type {
  AgentProvider,
  AgentMode,
  AgentSessionConfig,
  AgentPersistenceHandle,
  AgentTimelineItem,
  AgentModelDefinition,
} from "@server/server/agent/agent-sdk-types";
import { useDaemonRequest } from "@/hooks/use-daemon-request";
import type { WSInboundMessage, SessionOutboundMessage } from "@server/server/messages";
import { formatConnectionStatus } from "@/utils/daemons";
import { trackAnalyticsEvent } from "@/utils/analytics";
import type { SessionContextValue } from "@/contexts/session-context";
import { useSessionForServer } from "@/hooks/use-session-directory";
import type { UseWebSocketReturn } from "@/hooks/use-websocket";
import { useSessionStore } from "@/stores/session-store";

export type CreateAgentInitialValues = {
  workingDir?: string;
  provider?: AgentProvider;
  modeId?: string | null;
  model?: string | null;
};

interface AgentFlowModalProps {
  isVisible: boolean;
  onClose: () => void;
  flow: "create" | "import";
  initialValues?: CreateAgentInitialValues;
  serverId?: string | null;
}

type DictationToastConfig = {
  variant: DictationToastVariant;
  title: string;
  subtitle?: string;
  meta?: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss?: () => void;
};

interface ModalWrapperProps {
  isVisible: boolean;
  onClose: () => void;
  initialValues?: CreateAgentInitialValues;
  serverId?: string | null;
}

const providerDefinitions = AGENT_PROVIDER_DEFINITIONS;
const providerDefinitionMap = new Map<AgentProvider, AgentProviderDefinition>(
  providerDefinitions.map((definition) => [definition.id, definition])
);

const fallbackDefinition = providerDefinitions[0];
const DEFAULT_PROVIDER: AgentProvider = fallbackDefinition?.id ?? "claude";
const DEFAULT_MODE_FOR_DEFAULT_PROVIDER =
  fallbackDefinition?.defaultModeId ?? "";
const BACKDROP_OPACITY = 0.55;
const IMPORT_PAGE_SIZE = 20;
const PROMPT_MIN_HEIGHT = 64;
const PROMPT_MAX_HEIGHT = 200;
const FORM_PREFERENCES_STORAGE_KEY = "@paseo:create-agent-preferences";
const IS_WEB = Platform.OS === "web";
const DICTATION_AGENT_ID = "__dictation__";

type WebTextInputKeyPressEvent = NativeSyntheticEvent<
  TextInputKeyPressEventData & {
    metaKey?: boolean;
    ctrlKey?: boolean;
    shiftKey?: boolean;
  }
>;

type TextAreaHandle = {
  scrollHeight?: number;
  style?: {
    height?: string;
    minHeight?: string;
    maxHeight?: string;
    overflowY?: string;
  } & Record<string, unknown>;
};

const isTextAreaLike = (node: unknown): node is TextAreaHandle => {
  if (!node || typeof node !== "object") {
    return false;
  }
  if (!("scrollHeight" in node) || !("style" in node)) {
    return false;
  }
  const style = (node as { style?: unknown }).style;
  if (!style || typeof style !== "object") {
    return false;
  }
  return true;
};

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
type DropdownKey = "assistant" | "permissions" | "model" | "workingDir" | "baseBranch";

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
}: AgentFlowModalProps) {
  const insets = useSafeAreaInsets();
  const { height: screenHeight, width: screenWidth } = useWindowDimensions();
  const slideOffset = useSharedValue(screenHeight);
  const backdropOpacity = useSharedValue(0);
  const { height: keyboardHeight } = useReanimatedKeyboardAnimation();
  const isCompactLayout = screenWidth < 720;
  const shouldHandlePromptDesktopSubmit = IS_WEB;
  const shouldAutoFocusPrompt = IS_WEB;
  const isImportFlow = flow === "import";
  const isCreateFlow = !isImportFlow;

  const { recentPaths, addRecentPath } = useRecentPaths();
  const { connectionStates } = useDaemonConnections();
  const daemonEntries = useMemo(() => Array.from(connectionStates.values()), [connectionStates]);
  const initialServerId = useMemo(() => {
    if (!serverId) {
      return null;
    }
    const exists = daemonEntries.some((entry) => entry.daemon.id === serverId);
    return exists ? serverId : null;
  }, [serverId, daemonEntries]);
  const [selectedServerId, setSelectedServerId] = useState<string | null>(initialServerId);
  const selectedSession = useSessionForServer(selectedServerId);
  const session = selectedSession ?? null;
  const getSession = useSessionStore((state) => state.getSession);

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

  const ws = session?.ws ?? null;
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
      subscribeConnectionStatus: () => () => {},
      getConnectionState: () => ({ isConnected: false, isConnecting: false }),
    }),
    []
  );
  const effectiveWs = ws ?? inertWebSocket;
  const createAgent = session?.createAgent;
  const resumeAgent = session?.resumeAgent;
  const sessionSendAgentAudio = session?.sendAgentAudio;
  const noopSendAgentAudio = useCallback<SessionContextValue["sendAgentAudio"]>(async () => {}, []);
  const sendAgentAudio = sessionSendAgentAudio ?? noopSendAgentAudio;
  const hasSendAgentAudio = Boolean(sessionSendAgentAudio);
  const agents = session?.agents;
  const providerModels = session?.providerModels;
  const requestProviderModels = session?.requestProviderModels;
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
  const [workingDir, setWorkingDir] = useState("");
  const [initialPrompt, setInitialPrompt] = useState("");
  const [promptInputHeight, setPromptInputHeight] = useState(PROMPT_MIN_HEIGHT);
  const [selectedProvider, setSelectedProvider] =
    useState<AgentProvider>(DEFAULT_PROVIDER);
  const [selectedMode, setSelectedMode] = useState(
    DEFAULT_MODE_FOR_DEFAULT_PROVIDER
  );
  const [selectedModel, setSelectedModel] = useState("");
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
  const [dictationDebugInfo, setDictationDebugInfo] = useState<AudioDebugInfo | null>(null);
  const [openDropdown, setOpenDropdown] = useState<DropdownKey | null>(null);
  const pendingRequestIdRef = useRef<string | null>(null);
  const shouldSyncBaseBranchRef = useRef(true);
  const [connectionStatus, setConnectionStatus] = useState(() =>
    effectiveWs.getConnectionState
      ? effectiveWs.getConnectionState()
      : { isConnected: effectiveWs.isConnected, isConnecting: effectiveWs.isConnecting }
  );
  const [dictationSuccessToastAt, setDictationSuccessToastAt] = useState<number | null>(null);
  const promptInputRef = useRef<
    TextInput | (TextInput & { getNativeRef?: () => unknown }) | null
  >(null);
  const focusPromptInputRef = useRef<() => void>(() => {});
  const promptInputHeightRef = useRef(PROMPT_MIN_HEIGHT);
  const promptBaselineHeightRef = useRef<number | null>(null);
  const formPreferencesHydratedRef = useRef(false);
  const userEditedPreferencesRef = useRef({
    provider: false,
    mode: false,
    model: false,
    workingDir: false,
  });
  const prevVisibilityRef = useRef(isVisible);
  const dictationRequestIdRef = useRef<string | null>(null);

  const handleDictationTranscript = useCallback(
    (text: string, _meta: { requestId: string }) => {
      if (!isCreateFlow || !text) {
        return;
      }
      setInitialPrompt((prev) => {
        if (!prev) {
          return text;
        }
        const needsSpace = /\s$/.test(prev);
        return `${prev}${needsSpace ? "" : " "}${text}`;
      });
      focusPromptInputRef.current?.();
    },
    [isCreateFlow, setInitialPrompt]
  );

  const handleDictationError = useCallback(
    (dictationError: Error) => {
      setErrorMessage(dictationError.message);
    },
    []
  );

  const canStartDictation = useCallback(() => {
    const allowed = isCreateFlow && !isLoading && isTargetDaemonReady && isWsConnected;
    console.log("[CreateAgentModal] canStartDictation", {
      allowed,
      isCreateFlow,
      isLoading,
      isTargetDaemonReady,
      isWsConnected,
    });
    return allowed;
  }, [isCreateFlow, isLoading, isTargetDaemonReady, isWsConnected]);

  const canConfirmDictation = useCallback(() => {
    const allowed = isTargetDaemonReady && hasSendAgentAudio;
    console.log("[CreateAgentModal] canConfirmDictation", {
      allowed,
      isTargetDaemonReady,
      hasSendAgentAudio,
    });
    return allowed;
  }, [hasSendAgentAudio, isTargetDaemonReady]);

  const {
    isRecording: isDictating,
    isProcessing: isDictationProcessing,
    volume: dictationVolume,
    pendingRequestId: dictationPendingRequestId,
    error: dictationError,
    status: dictationStatus,
    retryAttempt: dictationRetryAttempt,
    maxRetryAttempts: dictationMaxRetryAttempts,
    retryInfo: dictationRetryInfo,
    failedRecording: dictationFailedRecording,
    lastOutcome: dictationLastOutcome,
    startDictation,
    cancelDictation,
    confirmDictation,
    reset: resetDictation,
    retryFailedDictation,
    discardFailedDictation,
  } = useDictation({
    agentId: DICTATION_AGENT_ID,
    sendAgentAudio,
    ws: effectiveWs,
    mode: "transcribe_only",
    onTranscript: handleDictationTranscript,
    onError: handleDictationError,
    canStart: canStartDictation,
    canConfirm: canConfirmDictation,
    autoStopWhenHidden: { isVisible },
  });
  const shouldShowAudioDebug = AUDIO_DEBUG_ENABLED;

  useEffect(() => {
    dictationRequestIdRef.current = dictationPendingRequestId;
  }, [dictationPendingRequestId]);

  useEffect(() => {
    if (!effectiveWs.subscribeConnectionStatus) {
      return;
    }
    return effectiveWs.subscribeConnectionStatus((status) => {
      setConnectionStatus(status);
    });
  }, [effectiveWs]);

  useEffect(() => {
    if (dictationLastOutcome?.type === "success") {
      setDictationSuccessToastAt(dictationLastOutcome.timestamp);
    }
  }, [dictationLastOutcome]);

  useEffect(() => {
    if (dictationSuccessToastAt === null) {
      return;
    }
    const timeout = setTimeout(() => {
      setDictationSuccessToastAt(null);
    }, 4000);
    return () => {
      clearTimeout(timeout);
    };
  }, [dictationSuccessToastAt]);

  const dictationSuccessToastVisible = dictationSuccessToastAt !== null;

  const hasPendingCreateOrResume = pendingRequestIdRef.current !== null;
  const hasPendingDictation = dictationPendingRequestId !== null;
  const shouldListenForStatus = isVisible || hasPendingCreateOrResume;
  const shouldListenForDictation =
    isCreateFlow && (isVisible || hasPendingDictation);

  const providerModelRequestTimersRef = useRef<
    Map<string, ReturnType<typeof setTimeout>>
  >(new Map());
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
  const clearQueuedProviderModelRequest = useCallback((serverId: string | null) => {
    if (!serverId) {
      return;
    }
    const timer = providerModelRequestTimersRef.current.get(serverId);
    if (timer) {
      clearTimeout(timer);
      providerModelRequestTimersRef.current.delete(serverId);
    }
  }, []);
  const queueProviderModelFetch = useCallback(
    (
      serverId: string | null,
      targetSession: SessionContextValue | null,
      options?: { cwd?: string; delayMs?: number }
    ) => {
      if (!serverId || !targetSession?.requestProviderModels) {
        clearQueuedProviderModelRequest(serverId);
        return;
      }
      const currentState = targetSession.providerModels?.get(selectedProvider);
      if (currentState?.models?.length || currentState?.isLoading) {
        clearQueuedProviderModelRequest(serverId);
        return;
      }

      const delayMs = options?.delayMs ?? 0;
      const trigger = () => {
        providerModelRequestTimersRef.current.delete(serverId);
        targetSession.requestProviderModels(selectedProvider, options?.cwd ? { cwd: options.cwd } : undefined);
      };
      clearQueuedProviderModelRequest(serverId);
      if (delayMs > 0) {
        providerModelRequestTimersRef.current.set(serverId, setTimeout(trigger, delayMs));
      } else {
        trigger();
      }
    },
    [clearQueuedProviderModelRequest, selectedProvider]
  );

  const setProviderFromUser = useCallback((provider: AgentProvider) => {
    userEditedPreferencesRef.current.provider = true;
    setSelectedProvider(provider);
    userEditedPreferencesRef.current.model = true;
    setSelectedModel("");
  }, []);

  const setModeFromUser = useCallback((modeId: string) => {
    userEditedPreferencesRef.current.mode = true;
    setSelectedMode(modeId);
  }, []);

  const setModelFromUser = useCallback((modelId: string) => {
    userEditedPreferencesRef.current.model = true;
    setSelectedModel(modelId);
  }, []);

  const setWorkingDirFromUser = useCallback((value: string) => {
    userEditedPreferencesRef.current.workingDir = true;
    setWorkingDir(value);
  }, []);

  const handleUserWorkingDirChange = useCallback(
    (value: string) => {
      setWorkingDirFromUser(value);
      setErrorMessage("");
    },
    [setWorkingDirFromUser]
  );

  const applyInitialValues = useCallback(() => {
    if (!isCreateFlow || !initialValues) {
      return;
    }

    if (Object.prototype.hasOwnProperty.call(initialValues, "workingDir")) {
      const providedWorkingDir = initialValues.workingDir ?? "";
      userEditedPreferencesRef.current.workingDir = true;
      setWorkingDir(providedWorkingDir);
    }

    if (initialValues.provider && providerDefinitionMap.has(initialValues.provider)) {
      userEditedPreferencesRef.current.provider = true;
      setSelectedProvider(initialValues.provider);
    }

    if (typeof initialValues.modeId === "string" && initialValues.modeId.length > 0) {
      userEditedPreferencesRef.current.mode = true;
      setSelectedMode(initialValues.modeId);
    }

    if (typeof initialValues.model === "string" && initialValues.model.length > 0) {
      userEditedPreferencesRef.current.model = true;
      setSelectedModel(initialValues.model);
    }
  }, [initialValues, isCreateFlow]);

  useEffect(() => {
    const wasVisible = prevVisibilityRef.current;
    if (isVisible && !wasVisible) {
      applyInitialValues();
    }
    prevVisibilityRef.current = isVisible;
  }, [applyInitialValues, isVisible]);

  const refreshProviderModels = useCallback(() => {
    if (!requestProviderModels) {
      return;
    }
    const trimmed = workingDir.trim();
    requestProviderModels(selectedProvider, {
      cwd: trimmed.length > 0 ? trimmed : undefined,
    });
  }, [requestProviderModels, selectedProvider, workingDir]);

  const handleBaseBranchChange = useCallback(
    (value: string) => {
      shouldSyncBaseBranchRef.current = false;
      setBaseBranch(value);
      setErrorMessage("");
    },
    [setErrorMessage]
  );

  useEffect(() => {
    let isActive = true;
    const hydratePreferences = async () => {
      try {
        const stored = await AsyncStorage.getItem(FORM_PREFERENCES_STORAGE_KEY);
        if (!stored || !isActive) {
          return;
        }
        const parsed = JSON.parse(stored) as {
          workingDir?: string;
          provider?: AgentProvider;
          mode?: string;
          model?: string;
        };
        if (
          parsed.provider &&
          providerDefinitionMap.has(parsed.provider) &&
          !userEditedPreferencesRef.current.provider
        ) {
          setSelectedProvider(parsed.provider);
        }
        if (
          typeof parsed.mode === "string" &&
          !userEditedPreferencesRef.current.mode
        ) {
          setSelectedMode(parsed.mode);
        }
        if (
          typeof parsed.workingDir === "string" &&
          !userEditedPreferencesRef.current.workingDir
        ) {
          setWorkingDir(parsed.workingDir);
        }
        if (
          typeof parsed.model === "string" &&
          !userEditedPreferencesRef.current.model
        ) {
          setSelectedModel(parsed.model);
        }
      } catch (error) {
        console.error(
          "[CreateAgentModal] Failed to hydrate form preferences:",
          error
        );
      } finally {
        if (isActive) {
          formPreferencesHydratedRef.current = true;
        }
      }
    };
    void hydratePreferences();
    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    if (!formPreferencesHydratedRef.current) {
      return;
    }
    const persist = async () => {
      try {
        await AsyncStorage.setItem(
          FORM_PREFERENCES_STORAGE_KEY,
          JSON.stringify({
            workingDir,
            provider: selectedProvider,
            mode: selectedMode,
            model: selectedModel,
          })
        );
      } catch (error) {
        console.error(
          "[CreateAgentModal] Failed to persist form preferences:",
          error
        );
      }
    };
    void persist();
  }, [selectedMode, selectedProvider, workingDir]);

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
  const agentDefinition = providerDefinitionMap.get(selectedProvider);
  const modeOptions = agentDefinition?.modes ?? [];
  const modelState = providerModels?.get(selectedProvider);
  const availableModels = modelState?.models ?? [];
  const isModelLoading = modelState?.isLoading ?? false;
  const modelError = modelState?.error ?? null;

  useEffect(() => {
    const targetServerId = selectedServerId ?? session?.serverId ?? null;
    if (!isVisible || !isTargetDaemonReady || !targetServerId || !session) {
      clearQueuedProviderModelRequest(targetServerId);
      return;
    }
    const trimmed = workingDir.trim();
    queueProviderModelFetch(targetServerId, session, {
      cwd: trimmed.length > 0 ? trimmed : undefined,
      delayMs: 180,
    });
    return () => {
      clearQueuedProviderModelRequest(targetServerId);
    };
  }, [
    clearQueuedProviderModelRequest,
    isTargetDaemonReady,
    isVisible,
    queueProviderModelFetch,
    selectedServerId,
    session,
    workingDir,
  ]);
  const setPromptHeight = useCallback((nextHeight: number) => {
    const bounded = Math.min(
      PROMPT_MAX_HEIGHT,
      Math.max(PROMPT_MIN_HEIGHT, nextHeight)
    );
    if (Math.abs(promptInputHeightRef.current - bounded) < 1) {
      return;
    }
    promptInputHeightRef.current = bounded;
    setPromptInputHeight(bounded);
  }, []);

  const applyPromptMeasuredHeight = useCallback(
    (measuredHeight: number) => {
      if (promptBaselineHeightRef.current === null) {
        promptBaselineHeightRef.current = measuredHeight;
      }
      const baseline = promptBaselineHeightRef.current ?? measuredHeight;
      const normalized = measuredHeight - baseline + PROMPT_MIN_HEIGHT;
      const bounded = Math.min(
        PROMPT_MAX_HEIGHT,
        Math.max(PROMPT_MIN_HEIGHT, normalized)
      );
      setPromptHeight(bounded);
      return bounded;
    },
    [setPromptHeight]
  );

  const getPromptWebTextArea = useCallback((): TextAreaHandle | null => {
    if (!IS_WEB) {
      return null;
    }
    const node = promptInputRef.current;
    if (!node) {
      return null;
    }
    if (isTextAreaLike(node)) {
      return node;
    }
    if (
      typeof (node as { getNativeRef?: () => unknown }).getNativeRef ===
      "function"
    ) {
      const native = (
        node as { getNativeRef?: () => unknown }
      ).getNativeRef?.();
      if (isTextAreaLike(native)) {
        return native;
      }
    }
    return null;
  }, []);

  const measurePromptWebInputHeight = useCallback(() => {
    if (!IS_WEB) {
      return false;
    }
    const element = getPromptWebTextArea();
    if (!element?.style || typeof element.scrollHeight !== "number") {
      return false;
    }
    const previousHeight = element.style.height;
    element.style.height = "auto";
    const measuredHeight = element.scrollHeight;
    element.style.height = previousHeight ?? "";
    const bounded = applyPromptMeasuredHeight(measuredHeight);
    element.style.height = `${bounded}px`;
    element.style.minHeight = `${PROMPT_MIN_HEIGHT}px`;
    element.style.maxHeight = `${PROMPT_MAX_HEIGHT}px`;
    element.style.overflowY = bounded >= PROMPT_MAX_HEIGHT ? "auto" : "hidden";
    return true;
  }, [applyPromptMeasuredHeight, getPromptWebTextArea]);

  const handlePromptContentSizeChange = useCallback(
    (event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>) => {
      if (IS_WEB && measurePromptWebInputHeight()) {
        return;
      }
      applyPromptMeasuredHeight(event.nativeEvent.contentSize.height);
    },
    [applyPromptMeasuredHeight, measurePromptWebInputHeight]
  );

  const focusPromptInput = useCallback(() => {
    if (!shouldAutoFocusPrompt) {
      return;
    }
    const node = promptInputRef.current;
    if (!node) {
      return;
    }
    const target:
      | (TextInput & { focus?: () => void })
      | { focus?: () => void }
      | null =
      typeof (node as { focus?: () => void }).focus === "function"
        ? node
        : typeof (node as { getNativeRef?: () => unknown }).getNativeRef ===
          "function"
        ? ((node as { getNativeRef?: () => unknown }).getNativeRef?.() as {
            focus?: () => void;
          } | null)
        : null;
    if (target && typeof target.focus === "function") {
      const exec = () => target.focus?.();
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(exec);
      } else {
        setTimeout(exec, 0);
      }
    }
  }, [shouldAutoFocusPrompt]);
  useEffect(() => {
    focusPromptInputRef.current = focusPromptInput;
  }, [focusPromptInput]);
  const activeSessionIds = useMemo(() => {
    const ids = new Set<string>();
    if (!agents) {
      return ids;
    }
    agents.forEach((agent) => {
      if (agent.sessionId) {
        ids.add(agent.sessionId);
      }
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

  useEffect(() => {
    if (!agentDefinition) {
      return;
    }

    if (modeOptions.length === 0) {
      if (selectedMode !== "") {
        setSelectedMode("");
      }
      return;
    }

    const availableModeIds = modeOptions.map((mode) => mode.id);

    if (!availableModeIds.includes(selectedMode)) {
      const fallbackModeId =
        agentDefinition.defaultModeId ?? availableModeIds[0];
      setSelectedMode(fallbackModeId);
    }
  }, [agentDefinition, selectedMode, modeOptions]);

  useLayoutEffect(() => {
    if (!IS_WEB) {
      return;
    }
    measurePromptWebInputHeight();
  }, [initialPrompt, measurePromptWebInputHeight]);

  useEffect(() => {
    if (!shouldAutoFocusPrompt) {
      return;
    }
    if (!isVisible || !isCreateFlow) {
      return;
    }
    focusPromptInput();
  }, [focusPromptInput, isCreateFlow, isVisible, shouldAutoFocusPrompt]);

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
    promptBaselineHeightRef.current = null;
    promptInputHeightRef.current = PROMPT_MIN_HEIGHT;
    setPromptHeight(PROMPT_MIN_HEIGHT);
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
    dictationRequestIdRef.current = null;
    setDictationDebugInfo(null);
    void cancelDictation();
    resetDictation();
    cancelRepoInfo();
  }, [cancelRepoInfo, cancelDictation, resetDictation, resetRepoInfo, setPromptHeight]);

  const handleDictationStart = useCallback(async () => {
    console.log("[CreateAgentModal] handleDictationStart", {
      isCreateFlow,
      isLoading,
      isDictating,
      isDictationProcessing,
      isTargetDaemonReady,
      isWsConnected,
    });
    if (!isCreateFlow || isLoading || isDictating || isDictationProcessing) {
      return;
    }
    if (!isTargetDaemonReady || !isWsConnected) {
      logOfflineDaemonAction(
        "dictation",
        daemonAvailabilityError ?? "WebSocket disconnected"
      );
      return;
    }
    try {
      if (shouldShowAudioDebug) {
        setDictationDebugInfo(null);
      }
      setErrorMessage("");
      await startDictation();
      console.log("[CreateAgentModal] startDictation invoked");
    } catch (error) {
      const isCancelled = error instanceof Error && error.message.includes("Recording cancelled");
      if (!isCancelled) {
        console.error("[CreateAgentModal] Failed to start dictation:", error);
      }
    }
  }, [
    daemonAvailabilityError,
    isCreateFlow,
    isDictating,
    isDictationProcessing,
    isLoading,
    isTargetDaemonReady,
    isWsConnected,
    logOfflineDaemonAction,
    shouldShowAudioDebug,
    startDictation,
  ]);

  const handleDictationCancel = useCallback(async () => {
    console.log("[CreateAgentModal] handleDictationCancel", {
      isDictating,
    });
    if (dictationStatus === "failed") {
      discardFailedDictation();
      return;
    }
    if (!isDictating) {
      return;
    }
    try {
      await cancelDictation();
    } catch (error) {
      console.error("[CreateAgentModal] Failed to cancel dictation:", error);
    }
  }, [cancelDictation, dictationStatus, discardFailedDictation, isDictating]);

  const handleDictationConfirm = useCallback(async () => {
    console.log("[CreateAgentModal] handleDictationConfirm", {
      isDictating,
      isDictationProcessing,
      isTargetDaemonReady,
      hasSendAgentAudio,
    });
    if (dictationStatus === "failed") {
      void retryFailedDictation();
      return;
    }
    if (!isDictating || isDictationProcessing) {
      return;
    }
    if (!isTargetDaemonReady || !hasSendAgentAudio) {
      logOfflineDaemonAction("dictation");
      setErrorMessage(
        daemonAvailabilityError ??
          "Dictation is unavailable until the selected host is online. Paseo reconnects automatically—try again once it comes back."
      );
      return;
    }
    try {
      await confirmDictation();
    } catch (error) {
      console.error("[CreateAgentModal] Failed to complete dictation:", error);
    }
  }, [
    daemonAvailabilityError,
    confirmDictation,
    dictationStatus,
    hasSendAgentAudio,
    isDictating,
    isDictationProcessing,
    isTargetDaemonReady,
    logOfflineDaemonAction,
    retryFailedDictation,
  ]);

  const handlePromptDictationRetry = useCallback(() => {
    void retryFailedDictation();
  }, [retryFailedDictation]);

  const handlePromptDictationDiscard = useCallback(() => {
    discardFailedDictation();
  }, [discardFailedDictation]);

  const promptDictationToast = useMemo<DictationToastConfig | null>(() => {
    if (!connectionStatus.isConnected) {
      return {
        variant: "warning",
        title: "Offline",
        subtitle: "Waiting for connection…",
      };
    }

    if (dictationStatus === "recording") {
      return {
        variant: "info",
        title: "Recording prompt…",
        subtitle: "Release to insert transcription",
      };
    }

    if (dictationStatus === "uploading") {
      const attemptLabel = `Attempt ${Math.max(1, dictationRetryAttempt || 1)}/${dictationMaxRetryAttempts}`;
      return {
        variant: "info",
        title: "Transcribing prompt…",
        meta: attemptLabel,
      };
    }

    if (dictationStatus === "retrying") {
      const attempt = dictationRetryInfo?.attempt ?? Math.max(1, dictationRetryAttempt || 1);
      const maxAttempts = dictationRetryInfo?.maxAttempts ?? dictationMaxRetryAttempts;
      const retryMeta =
        dictationRetryInfo?.nextRetryMs && dictationRetryInfo.nextRetryMs > 0
          ? `Attempt ${attempt}/${maxAttempts} · Next in ${Math.ceil(dictationRetryInfo.nextRetryMs / 1000)}s`
          : `Attempt ${attempt}/${maxAttempts}`;
      return {
        variant: "warning",
        title: "Retrying dictation…",
        subtitle: dictationRetryInfo?.errorMessage ?? dictationError ?? "Network error",
        meta: retryMeta,
      };
    }

    if (dictationStatus === "failed") {
      return {
        variant: "error",
        title: "Dictation failed",
        subtitle: dictationRetryInfo?.errorMessage ?? dictationError ?? "Unknown error",
        actionLabel: "Retry",
        onAction: handlePromptDictationRetry,
        onDismiss: handlePromptDictationDiscard,
      };
    }

    if (dictationSuccessToastVisible) {
      return {
        variant: "success",
        title: "Transcribed",
        subtitle: "Inserted into prompt",
      };
    }

    return null;
  }, [
    connectionStatus.isConnected,
    dictationError,
    dictationMaxRetryAttempts,
    dictationRetryAttempt,
    dictationRetryInfo,
    dictationStatus,
    dictationSuccessToastVisible,
    handlePromptDictationDiscard,
    handlePromptDictationRetry,
  ]);

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

  const handleSelectServer = useCallback((serverId: string) => {
    setSelectedServerId(serverId);
  }, []);

  const handleCloseAnimationComplete = useCallback(() => {
    console.log("[CreateAgentModal] close animation complete – resetting form");
    resetFormState();
    setIsMounted(false);
    navigateToAgentIfNeeded();
  }, [navigateToAgentIfNeeded, resetFormState]);

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
      providerModelRequestTimersRef.current.forEach((timer) => {
        clearTimeout(timer);
      });
      providerModelRequestTimersRef.current.clear();
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
    const activeServerIds = new Set(daemonEntries.map(({ daemon }) => daemon.id));
    providerModelRequestTimersRef.current.forEach((timer, serverId) => {
      if (!activeServerIds.has(serverId)) {
        clearTimeout(timer);
        providerModelRequestTimersRef.current.delete(serverId);
      }
    });

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
        const daemonSession = getSession(serverId) ?? null;
        if (!daemonSession?.ws?.isConnected) {
          return;
        }
        queueProviderModelFetch(serverId, daemonSession, { delayMs: 320 });
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
    getSession,
  ]);

  const trimmedWorkingDir = workingDir.trim();
  const shouldInspectRepo = isCreateFlow && isVisible && trimmedWorkingDir.length > 0;
  const repoAvailabilityError = shouldInspectRepo && (!isTargetDaemonReady || !isWsConnected)
    ? daemonAvailabilityError ??
      "Repository details will load automatically once the selected host is back online."
    : null;
  const repoInfoStatus: "idle" | "loading" | "ready" | "error" = !shouldInspectRepo
    ? "idle"
    : repoAvailabilityError
      ? "error"
      : repoRequestStatus === "loading"
        ? "loading"
        : repoRequestStatus === "error"
          ? "error"
          : repoRequestStatus === "success"
            ? "ready"
            : "idle";
  const repoInfoError = repoAvailabilityError ?? repoRequestError?.message ?? null;

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

    const gitOptions = shouldIncludeBase
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
    if (!shouldListenForDictation || !ws || !shouldShowAudioDebug) {
      return;
    }
    const unsubscribe = ws.on("transcription_result", (message) => {
      if (message.type !== "transcription_result") {
        return;
      }
      const pendingId = dictationRequestIdRef.current;
      if (!pendingId || message.payload.requestId !== pendingId) {
        return;
      }
      dictationRequestIdRef.current = null;
      setDictationDebugInfo({
        requestId: pendingId,
        transcript: message.payload.text?.trim(),
        debugRecordingPath: message.payload.debugRecordingPath ?? undefined,
        format: message.payload.format,
        byteLength: message.payload.byteLength,
        duration: message.payload.duration,
        avgLogprob: message.payload.avgLogprob,
        isLowConfidence: message.payload.isLowConfidence,
      });
    });

    return () => {
      unsubscribe();
    };
  }, [shouldListenForDictation, shouldShowAudioDebug, ws]);

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
  const dictationAccessory = isCreateFlow ? (
    <PromptDictationControls
      isRecording={isDictating}
      isProcessing={isDictationProcessing}
      disabled={isLoading || !isWsConnected || !isTargetDaemonReady}
      volume={dictationVolume}
      onStart={handleDictationStart}
      onCancel={handleDictationCancel}
      onConfirm={handleDictationConfirm}
      status={dictationStatus}
      retryAttempt={dictationRetryAttempt}
      maxRetryAttempts={dictationMaxRetryAttempts}
      retryCountdownMs={dictationRetryInfo?.nextRetryMs}
      errorMessage={dictationRetryInfo?.errorMessage ?? dictationError ?? undefined}
      onRetry={handlePromptDictationRetry}
      onDiscard={handlePromptDictationDiscard}
    />
  ) : null;

  const gitBlockingError = useMemo(() => {
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
    repoInfo,
    validateWorktreeName,
    worktreeSlug,
  ]);

  const workingDirIsEmpty = !workingDir.trim();
  const promptIsEmpty = !initialPrompt.trim();
  const createDisabled =
    workingDirIsEmpty ||
    promptIsEmpty ||
    Boolean(gitBlockingError) ||
    isLoading ||
    !isTargetDaemonReady;
  const handlePromptDesktopSubmitKeyPress = useCallback(
    (event: WebTextInputKeyPressEvent) => {
      if (!shouldHandlePromptDesktopSubmit) {
        return;
      }
      if (event.nativeEvent.key !== "Enter") {
        return;
      }
      const { shiftKey, metaKey, ctrlKey } = event.nativeEvent;
      if (shiftKey || metaKey || ctrlKey) {
        return;
      }
      if (createDisabled) {
        return;
      }
      event.preventDefault();
      void handleCreate();
    },
    [createDisabled, handleCreate, shouldHandlePromptDesktopSubmit]
  );
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

                  <PromptSection
                    value={initialPrompt}
                    isLoading={isLoading}
                    onChange={(text) => {
                      setInitialPrompt(text);
                      setErrorMessage("");
                    }}
                    inputRef={promptInputRef}
                    inputHeight={promptInputHeight}
                    onContentSizeChange={handlePromptContentSizeChange}
                    onDesktopSubmit={handlePromptDesktopSubmitKeyPress}
                    autoFocus={shouldAutoFocusPrompt}
                    scrollEnabled={promptInputHeight >= PROMPT_MAX_HEIGHT}
                    accessory={dictationAccessory}
                  />

                  {shouldShowAudioDebug && dictationDebugInfo ? (
                    <AudioDebugNotice
                      info={dictationDebugInfo}
                      onDismiss={() => setDictationDebugInfo(null)}
                      title="Prompt Dictation Debug"
                    />
                  ) : null}

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
                    recentPaths={recentPaths}
                    onSelectPath={handleUserWorkingDirChange}
                  />

                  <GitOptionsSection
                    baseBranch={baseBranch}
                    onBaseBranchChange={handleBaseBranchChange}
                    branches={repoInfo?.branches ?? []}
                    status={repoInfoStatus}
                    repoError={repoInfoError}
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
                {promptDictationToast ? (
                  <View style={styles.dictationToastPortal} pointerEvents="box-none">
                    <View pointerEvents="auto">
                      <DictationStatusNotice {...promptDictationToast} />
                    </View>
                  </View>
                ) : null}
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
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

export function CreateAgentModal(props: ModalWrapperProps) {
  return <AgentFlowModal {...props} flow="create" />;
}

export function ImportAgentModal(props: ModalWrapperProps) {
  return <AgentFlowModal {...props} flow="import" />;
}

interface ModalHeaderProps {
  paddingTop: number;
  paddingLeft: number;
  paddingRight: number;
  onClose: () => void;
  title: string;
}

function ModalHeader({
  paddingTop,
  paddingLeft,
  paddingRight,
  onClose,
  title,
}: ModalHeaderProps): ReactElement {
  return (
    <View style={[styles.header, { paddingTop, paddingLeft, paddingRight }]}>
      <Text style={styles.headerTitle}>{title}</Text>
      <Pressable onPress={onClose} style={styles.closeButton} hitSlop={8}>
        <X size={20} color={defaultTheme.colors.mutedForeground} />
      </Pressable>
    </View>
  );
}

interface DropdownFieldProps {
  label: string;
  value: string;
  placeholder: string;
  onPress: () => void;
  disabled?: boolean;
  errorMessage?: string | null;
  warningMessage?: string | null;
  helperText?: string | null;
}

function DropdownField({
  label,
  value,
  placeholder,
  onPress,
  disabled,
  errorMessage,
  warningMessage,
  helperText,
}: DropdownFieldProps): ReactElement {
  return (
    <View style={styles.formSection}>
      <Text style={styles.label}>{label}</Text>
      <Pressable
        onPress={onPress}
        disabled={disabled}
        style={[styles.dropdownControl, disabled && styles.dropdownControlDisabled]}
      >
        <Text
          style={value ? styles.dropdownValue : styles.dropdownPlaceholder}
          numberOfLines={1}
        >
          {value || placeholder}
        </Text>
        <ChevronDown size={16} color={defaultTheme.colors.mutedForeground} />
      </Pressable>
      {errorMessage ? (
        <Text style={styles.errorText}>{errorMessage}</Text>
      ) : null}
      {warningMessage ? (
        <Text style={styles.warningText}>{warningMessage}</Text>
      ) : null}
      {!errorMessage && helperText ? (
        <Text style={styles.helperText}>{helperText}</Text>
      ) : null}
    </View>
  );
}

interface DropdownSheetProps {
  title: string;
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
}

function DropdownSheet({ title, visible, onClose, children }: DropdownSheetProps): ReactElement {
  return (
    <Modal
      transparent
      animationType="fade"
      visible={visible}
      onRequestClose={onClose}
    >
      <View style={styles.dropdownSheetOverlay}>
        <Pressable style={styles.dropdownSheetBackdrop} onPress={onClose} />
        <View style={styles.dropdownSheetContainer}>
          <View style={styles.dropdownSheetHandle} />
          <Text style={styles.dropdownSheetTitle}>{title}</Text>
          <ScrollView
            contentContainerStyle={styles.dropdownSheetScrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

interface AssistantDropdownProps {
  providerDefinitions: AgentProviderDefinition[];
  selectedProvider: AgentProvider;
  disabled: boolean;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  onSelect: (provider: AgentProvider) => void;
}

function AssistantDropdown({
  providerDefinitions,
  selectedProvider,
  disabled,
  isOpen,
  onOpen,
  onClose,
  onSelect,
}: AssistantDropdownProps): ReactElement {
  const selectedDefinition = providerDefinitions.find(
    (definition) => definition.id === selectedProvider
  );
  return (
    <View style={styles.selectorColumn}>
      <DropdownField
        label="Assistant"
        value={selectedDefinition?.label ?? ""}
        placeholder="Select assistant"
        onPress={onOpen}
        disabled={disabled}
      />
      <DropdownSheet title="Choose Assistant" visible={isOpen} onClose={onClose}>
        {providerDefinitions.map((definition) => {
          const isSelected = definition.id === selectedProvider;
          return (
            <Pressable
              key={definition.id}
              style={[
                styles.dropdownSheetOption,
                isSelected && styles.dropdownSheetOptionSelected,
              ]}
              onPress={() => {
                onSelect(definition.id);
                onClose();
              }}
            >
              <Text style={styles.dropdownSheetOptionLabel}>{definition.label}</Text>
              {definition.description ? (
                <Text style={styles.dropdownSheetOptionDescription}>
                  {definition.description}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </DropdownSheet>
    </View>
  );
}

interface PermissionsDropdownProps {
  modeOptions: AgentMode[];
  selectedMode: string;
  disabled: boolean;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  onSelect: (modeId: string) => void;
}

function PermissionsDropdown({
  modeOptions,
  selectedMode,
  disabled,
  isOpen,
  onOpen,
  onClose,
  onSelect,
}: PermissionsDropdownProps): ReactElement {
  const hasOptions = modeOptions.length > 0;
  const selectedModeLabel = hasOptions
    ? modeOptions.find((mode) => mode.id === selectedMode)?.label ??
      modeOptions[0]?.label ??
      "Default"
    : "Automatic";
  return (
    <View style={[styles.selectorColumn, styles.selectorColumnFull]}>
      <DropdownField
        label="Permissions"
        value={selectedModeLabel}
        placeholder={hasOptions ? "Select permissions" : "Automatic"}
        onPress={hasOptions ? onOpen : () => {}}
        disabled={disabled || !hasOptions}
        helperText={
          hasOptions
            ? undefined
            : "This assistant does not expose selectable permissions."
        }
      />
      {hasOptions ? (
        <DropdownSheet title="Permissions" visible={isOpen} onClose={onClose}>
          {modeOptions.map((mode) => {
            const isSelected = mode.id === selectedMode;
            return (
              <Pressable
                key={mode.id}
                style={[
                  styles.dropdownSheetOption,
                  isSelected && styles.dropdownSheetOptionSelected,
                ]}
                onPress={() => {
                  onSelect(mode.id);
                  onClose();
                }}
              >
                <Text style={styles.dropdownSheetOptionLabel}>{mode.label}</Text>
                {mode.description ? (
                  <Text style={styles.dropdownSheetOptionDescription}>
                    {mode.description}
                  </Text>
                ) : null}
              </Pressable>
            );
          })}
        </DropdownSheet>
      ) : null}
    </View>
  );
}

interface ModelDropdownProps {
  models: AgentModelDefinition[];
  selectedModel: string;
  isLoading: boolean;
  error: string | null;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  onSelect: (modelId: string) => void;
  onClear: () => void;
  onRefresh: () => void;
}

function ModelDropdown({
  models,
  selectedModel,
  isLoading,
  error,
  isOpen,
  onOpen,
  onClose,
  onSelect,
  onClear,
  onRefresh,
}: ModelDropdownProps): ReactElement {
  const selectedLabel = selectedModel
    ? models.find((model) => model.id === selectedModel)?.label ?? selectedModel
    : "Automatic";
  const placeholder = isLoading && models.length === 0 ? "Loading..." : "Automatic";
  const helperText = error
    ? undefined
    : isLoading
      ? "Fetching available models..."
      : models.length === 0
        ? "This assistant did not expose selectable models."
        : undefined;

  return (
    <View style={styles.selectorColumn}>
      <DropdownField
        label="Model"
        value={selectedLabel}
        placeholder={placeholder}
        onPress={onOpen}
        disabled={false}
        errorMessage={error ?? undefined}
        helperText={helperText}
      />
      <DropdownSheet title="Model" visible={isOpen} onClose={onClose}>
        <Pressable
          style={styles.dropdownSheetOption}
          onPress={() => {
            onClear();
            onClose();
          }}
        >
          <Text style={styles.dropdownSheetOptionLabel}>Automatic (provider default)</Text>
          <Text style={styles.dropdownSheetOptionDescription}>
            Let the assistant pick the recommended model.
          </Text>
        </Pressable>
        {models.map((model) => {
          const isSelected = model.id === selectedModel;
          return (
            <Pressable
              key={model.id}
              style={[
                styles.dropdownSheetOption,
                isSelected && styles.dropdownSheetOptionSelected,
              ]}
              onPress={() => {
                onSelect(model.id);
                onClose();
              }}
            >
              <Text style={styles.dropdownSheetOptionLabel}>{model.label}</Text>
              {model.description ? (
                <Text style={styles.dropdownSheetOptionDescription}>
                  {model.description}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
        <Pressable
          style={styles.dropdownSheetOption}
          onPress={() => {
            onRefresh();
          }}
        >
          <Text style={styles.dropdownSheetOptionLabel}>Refresh models</Text>
          <Text style={styles.dropdownSheetOptionDescription}>
            Request the latest catalog from the provider.
          </Text>
        </Pressable>
        {isLoading ? (
          <View style={styles.dropdownSheetLoading}>
            <ActivityIndicator size="small" color={defaultTheme.colors.foreground} />
          </View>
        ) : null}
      </DropdownSheet>
    </View>
  );
}

interface WorkingDirectoryDropdownProps {
  workingDir: string;
  errorMessage: string;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  disabled: boolean;
  recentPaths: string[];
  onSelectPath: (value: string) => void;
}

function WorkingDirectoryDropdown({
  workingDir,
  errorMessage,
  isOpen,
  onOpen,
  onClose,
  disabled,
  recentPaths,
  onSelectPath,
}: WorkingDirectoryDropdownProps): ReactElement {
  const inputRef = useRef<TextInput | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    if (isOpen) {
      setSearchQuery("");
      inputRef.current?.focus();
    }
  }, [isOpen]);

  const normalizedSearch = searchQuery.trim().toLowerCase();
  const filteredPaths = useMemo(() => {
    if (!normalizedSearch) {
      return recentPaths;
    }
    return recentPaths.filter((path) =>
      path.toLowerCase().includes(normalizedSearch)
    );
  }, [recentPaths, normalizedSearch]);

  const hasRecentPaths = recentPaths.length > 0;
  const hasMatches = filteredPaths.length > 0;
  const sanitizedSearchValue = searchQuery.trim();
  const showCustomOption = sanitizedSearchValue.length > 0;

  const handleSelect = useCallback(
    (path: string) => {
      onSelectPath(path);
      onClose();
    },
    [onClose, onSelectPath]
  );

  return (
    <View style={styles.formSection}>
      <DropdownField
        label="Working Directory"
        value={workingDir}
        placeholder="/path/to/project"
        onPress={onOpen}
        disabled={disabled}
        errorMessage={errorMessage || undefined}
        helperText={
          hasRecentPaths
            ? "Search saved directories or paste a new path."
            : "No saved directories yet - search to add one."
        }
      />
      <DropdownSheet title="Working Directory" visible={isOpen} onClose={onClose}>
        <TextInput
          ref={inputRef}
          style={styles.dropdownSearchInput}
          placeholder="/path/to/project"
          placeholderTextColor={defaultTheme.colors.mutedForeground}
          value={searchQuery}
          onChangeText={setSearchQuery}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {!hasRecentPaths && !showCustomOption ? (
          <Text style={styles.helperText}>
            We will remember the directories you use most often.
          </Text>
        ) : null}
        {showCustomOption ? (
          <View style={styles.dropdownSheetList}>
            <Pressable
              key="working-dir-custom-option"
              style={styles.dropdownSheetOption}
              onPress={() => handleSelect(sanitizedSearchValue)}
            >
              <Text style={styles.dropdownSheetOptionLabel} numberOfLines={1}>
                {`Use "${sanitizedSearchValue}"`}
              </Text>
              <Text style={styles.dropdownSheetOptionDescription}>
                Launch the agent in this directory
              </Text>
            </Pressable>
          </View>
        ) : null}
        {hasMatches ? (
          <View style={styles.dropdownSheetList}>
            {filteredPaths.map((path) => {
              const isActive = path === workingDir;
              return (
                <Pressable
                  key={path}
                  style={[
                    styles.dropdownSheetOption,
                    isActive && styles.dropdownSheetOptionSelected,
                  ]}
                  onPress={() => handleSelect(path)}
                >
                  <Text style={styles.dropdownSheetOptionLabel} numberOfLines={1}>
                    {path}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : hasRecentPaths ? (
          <Text style={styles.helperText}>
            No recent paths match your search.
          </Text>
        ) : null}
      </DropdownSheet>
    </View>
  );
}

interface PromptSectionProps {
  value: string;
  isLoading: boolean;
  onChange: (value: string) => void;
  inputRef: RefObject<
    TextInput | (TextInput & { getNativeRef?: () => unknown }) | null
  >;
  inputHeight: number;
  onContentSizeChange: (
    event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>
  ) => void;
  onDesktopSubmit?: (event: WebTextInputKeyPressEvent) => void;
  autoFocus?: boolean;
  scrollEnabled: boolean;
  accessory?: ReactNode;
}

function PromptSection({
  value,
  isLoading,
  onChange,
  inputRef,
  inputHeight,
  onContentSizeChange,
  onDesktopSubmit,
  autoFocus,
  scrollEnabled,
  accessory,
}: PromptSectionProps): ReactElement {
  return (
    <View style={styles.formSection}>
      <View style={styles.labelRow}>
        <Text style={styles.label}>Initial Prompt</Text>
        {accessory}
      </View>
      <TextInput
        ref={inputRef}
        style={[
          styles.input,
          styles.promptInput,
          isLoading && styles.inputDisabled,
          {
            height: inputHeight,
            minHeight: PROMPT_MIN_HEIGHT,
            maxHeight: PROMPT_MAX_HEIGHT,
          },
        ]}
        placeholder="Describe what you want the agent to do"
        placeholderTextColor={defaultTheme.colors.mutedForeground}
        value={value}
        onChangeText={onChange}
        autoCapitalize="sentences"
        autoCorrect
        multiline
        scrollEnabled={scrollEnabled}
        onContentSizeChange={onContentSizeChange}
        editable={!isLoading}
        autoFocus={autoFocus}
        blurOnSubmit={false}
        onKeyPress={onDesktopSubmit}
      />
    </View>
  );
}

interface PromptDictationControlsProps {
  isRecording: boolean;
  isProcessing: boolean;
  disabled: boolean;
  volume: number;
  onStart: () => void;
  onCancel: () => void;
  onConfirm: () => void;
  status: DictationStatus;
  retryAttempt: number;
  maxRetryAttempts: number;
  retryCountdownMs?: number | null;
  errorMessage?: string | null;
  onRetry?: () => void;
  onDiscard?: () => void;
}

function PromptDictationControls({
  isRecording,
  isProcessing,
  disabled,
  volume,
  onStart,
  onCancel,
  onConfirm,
  status,
  retryAttempt,
  maxRetryAttempts,
  retryCountdownMs,
  errorMessage,
  onRetry,
  onDiscard,
}: PromptDictationControlsProps): ReactElement {
  const { theme } = useUnistyles();

  const isRetrying = status === "retrying";
  const isFailed = status === "failed";
  const showActiveState = isRecording || isProcessing || isRetrying || isFailed;
  const cancelHandler = isFailed ? onDiscard ?? onCancel : onCancel;
  const confirmHandler = isFailed ? onRetry ?? onConfirm : onConfirm;

  if (!showActiveState) {
    return (
      <Pressable
        onPress={onStart}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel="Start voice dictation"
        style={[styles.dictationButton, disabled && styles.dictationButtonDisabled]}
      >
        <Mic size={16} color={theme.colors.foreground} />
      </Pressable>
    );
  }

  return (
    <View style={styles.dictationActiveContainer}>
      <View style={styles.dictationMeterWrapper}>
        <VolumeMeter
          volume={volume}
          isMuted={false}
          isDetecting
          isSpeaking={false}
          orientation="horizontal"
        />
      </View>
      <View style={styles.dictationActionGroup}>
        <Pressable
          onPress={cancelHandler}
          disabled={isProcessing && !isFailed}
          accessibilityLabel="Cancel dictation"
          style={[
            styles.dictationActionButton,
            styles.dictationActionButtonCancel,
            isProcessing && !isFailed ? styles.dictationActionButtonDisabled : undefined,
          ]}
        >
          <X size={14} color={theme.colors.foreground} />
        </Pressable>
        <Pressable
          onPress={confirmHandler}
          disabled={isProcessing}
          accessibilityLabel={isFailed ? "Retry dictation" : "Insert transcription"}
          style={[
            styles.dictationActionButton,
            styles.dictationActionButtonConfirm,
            isProcessing ? styles.dictationActionButtonDisabled : undefined,
          ]}
        >
          {isProcessing || isRetrying ? (
            <ActivityIndicator size="small" color={theme.colors.background} />
          ) : isFailed ? (
            <RefreshCcw size={14} color={theme.colors.background} />
          ) : (
            <Check size={14} color={theme.colors.background} />
          )}
        </Pressable>
      </View>
      {(isRetrying || isFailed) && (
        <Text style={[styles.dictationStatusLabel, { color: theme.colors.mutedForeground }]}>
          {isRetrying
            ? `Retrying ${Math.max(1, retryAttempt)} / ${Math.max(1, maxRetryAttempts)}${
                retryCountdownMs && retryCountdownMs > 0
                  ? ` in ${Math.ceil(retryCountdownMs / 1000)}s`
                  : ""
              }`
            : errorMessage ?? "Dictation failed"}
        </Text>
      )}
    </View>
  );
}

interface GitOptionsSectionProps {
  baseBranch: string;
  onBaseBranchChange: (value: string) => void;
  branches: Array<{ name: string; isCurrent: boolean }>;
  status: "idle" | "loading" | "ready" | "error";
  repoError: string | null;
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
        disabled={status === "loading"}
        errorMessage={repoError}
        warningMessage={!gitValidationError ? warning : null}
        helperText={
          status === "loading"
            ? "Inspecting repository…"
            : "Search existing branches, then tap to select."
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
  dictationToastPortal: {
    position: "absolute",
    left: theme.spacing[4],
    right: theme.spacing[4],
    bottom: theme.spacing[6],
  },
  dictationNoticeWrapper: {
    marginTop: theme.spacing[3],
  },
  formSection: {
    gap: theme.spacing[3],
  },
  labelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
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
  promptInput: {
    minHeight: theme.spacing[24],
    textAlignVertical: "top",
    outlineWidth: 0,
    outlineColor: "transparent",
    outlineStyle: "none",
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
  dictationButton: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.full,
    padding: theme.spacing[2],
    alignItems: "center",
    justifyContent: "center",
  },
  dictationButtonDisabled: {
    opacity: theme.opacity[50],
  },
  dictationActiveContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  dictationMeterWrapper: {
    width: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  dictationActionGroup: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  dictationActionButton: {
    width: 32,
    height: 32,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: theme.borderWidth[1],
  },
  dictationActionButtonCancel: {
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
  dictationActionButtonConfirm: {
    borderColor: theme.colors.foreground,
    backgroundColor: theme.colors.foreground,
  },
  dictationActionButtonDisabled: {
    opacity: theme.opacity[40],
  },
  dictationStatusLabel: {
    marginTop: theme.spacing[1],
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
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
