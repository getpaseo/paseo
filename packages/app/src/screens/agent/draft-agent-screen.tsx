import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createNameId } from "mnemonic-id";
import type { ImageAttachment } from "@/components/message-input";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  Keyboard,
  Platform,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { Monitor } from "lucide-react-native";
import { MenuHeader } from "@/components/headers/menu-header";
import { AgentInputArea } from "@/components/agent-input-area";
import { AgentStreamView } from "@/components/agent-stream-view";
import {
  DropdownSheet,
  GitOptionsSection,
  WorkingDirectoryDropdown,
  AgentConfigRow,
} from "@/components/agent-form/agent-form-dropdowns";
import { FileDropZone } from "@/components/file-drop-zone";
import { useQuery } from "@tanstack/react-query";
import { useAgentFormState, type CreateAgentInitialValues } from "@/hooks/use-agent-form-state";
import {
  CHECKOUT_STATUS_STALE_TIME,
  checkoutStatusQueryKey,
} from "@/hooks/use-checkout-status-query";
import { useDaemonConnections } from "@/contexts/daemon-connections-context";
import { useDaemonRegistry } from "@/contexts/daemon-registry-context";
import { formatConnectionStatus } from "@/utils/daemons";
import { useSessionStore } from "@/stores/session-store";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import { WelcomeScreen } from "@/components/welcome-screen";
import type { Agent } from "@/contexts/session-context";
import type { StreamItem } from "@/types/stream";
import { generateMessageId } from "@/types/stream";
import { encodeImages } from "@/utils/encode-images";
import type {
  AgentProvider,
  AgentCapabilityFlags,
  AgentSessionConfig,
} from "@server/server/agent/agent-sdk-types";
import { AGENT_PROVIDER_DEFINITIONS } from "@server/server/agent/provider-manifest";

const DRAFT_AGENT_ID = "__new_agent__";
const EMPTY_PENDING_PERMISSIONS = new Map();
const EMPTY_STREAM_ITEMS: StreamItem[] = [];
const DRAFT_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: false,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
};
const PROVIDER_DEFINITION_MAP = new Map(
  AGENT_PROVIDER_DEFINITIONS.map((definition) => [definition.id, definition])
);

function getParamValue(value: string | string[] | undefined) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const trimmed = entry.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  return undefined;
}

function getValidProvider(value: string | undefined) {
  if (!value) {
    return undefined;
  }
  return PROVIDER_DEFINITION_MAP.has(value as AgentProvider)
    ? (value as AgentProvider)
    : undefined;
}

function getValidMode(
  provider: AgentProvider | undefined,
  value: string | undefined
) {
  if (!provider || !value) {
    return undefined;
  }
  const definition = PROVIDER_DEFINITION_MAP.get(provider);
  const modes = definition?.modes ?? [];
  return modes.some((mode) => mode.id === value) ? value : undefined;
}

type DraftAgentParams = {
  serverId?: string;
  provider?: string;
  modeId?: string;
  model?: string;
  workingDir?: string;
};

type DraftAgentScreenProps = {
  isVisible?: boolean;
  onCreateFlowActiveChange?: (active: boolean) => void;
};

export function DraftAgentScreen({
  isVisible = true,
  onCreateFlowActiveChange,
}: DraftAgentScreenProps = {}) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { connectionStates } = useDaemonConnections();
  const { daemons } = useDaemonRegistry();
  const params = useLocalSearchParams<DraftAgentParams>();

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

  const resolvedServerId = getParamValue(params.serverId);
  const resolvedProvider = getValidProvider(getParamValue(params.provider));
  const resolvedMode = getValidMode(resolvedProvider, getParamValue(params.modeId));
  const resolvedModel = getParamValue(params.model);
  const resolvedWorkingDir = getParamValue(params.workingDir);

  const initialValues = useMemo((): CreateAgentInitialValues => {
    const values: CreateAgentInitialValues = {};
    if (resolvedWorkingDir) {
      values.workingDir = resolvedWorkingDir;
    }
    if (resolvedProvider) {
      values.provider = resolvedProvider;
    }
    if (resolvedMode) {
      values.modeId = resolvedMode;
    }
    if (resolvedModel) {
      values.model = resolvedModel;
    }
    return values;
  }, [resolvedMode, resolvedModel, resolvedProvider, resolvedWorkingDir]);

  const {
    selectedServerId,
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
    modeOptions,
    availableModels,
    isModelLoading,
    modelError,
    refreshProviderModels,
    persistFormPreferences,
  } = useAgentFormState({
    initialServerId: resolvedServerId ?? null,
    initialValues,
    isVisible,
    isCreateFlow: true,
  });
  const hostEntry = selectedServerId
    ? connectionStates.get(selectedServerId)
    : undefined;
  const hostLabel =
    hostEntry?.daemon.label ?? selectedServerId ?? "Select host";
  const hostStatus = hostEntry?.status
    ? formatConnectionStatus(hostEntry.status)
    : undefined;

  const [openDropdown, setOpenDropdown] = useState<"host" | null>(null);
  const [worktreeMode, setWorktreeMode] = useState<"none" | "create" | "attach">("none");
  const [baseBranch, setBaseBranch] = useState("");
  const [worktreeSlug, setWorktreeSlug] = useState("");
  const [selectedWorktreePath, setSelectedWorktreePath] = useState("");
  const addImagesRef = useRef<((images: ImageAttachment[]) => void) | null>(null);
  const setPendingCreateAttempt = useCreateFlowStore((state) => state.setPending);
  const updatePendingAgentId = useCreateFlowStore((state) => state.updateAgentId);
  const clearPendingCreateAttempt = useCreateFlowStore((state) => state.clear);

  type CreateAttempt = {
    messageId: string;
    text: string;
    timestamp: Date;
  };

  type DraftAgentMachineState =
    | { tag: "draft"; promptText: string; errorMessage: string }
    | { tag: "creating"; attempt: CreateAttempt };

  type DraftAgentMachineEvent =
    | { type: "DRAFT_SET_PROMPT"; text: string }
    | { type: "DRAFT_SET_ERROR"; message: string }
    | { type: "SUBMIT"; attempt: CreateAttempt }
    | { type: "CREATE_FAILED"; message: string };

  function assertNever(value: never): never {
    throw new Error(`Unhandled state: ${JSON.stringify(value)}`);
  }

  const [machine, dispatch] = useReducer(
    (state: DraftAgentMachineState, event: DraftAgentMachineEvent): DraftAgentMachineState => {
      switch (event.type) {
        case "DRAFT_SET_PROMPT": {
          if (state.tag !== "draft") {
            return state;
          }
          return { ...state, promptText: event.text };
        }
        case "DRAFT_SET_ERROR": {
          if (state.tag !== "draft") {
            return state;
          }
          return { ...state, errorMessage: event.message };
        }
        case "SUBMIT": {
          return { tag: "creating", attempt: event.attempt };
        }
        case "CREATE_FAILED": {
          if (state.tag !== "creating") {
            return state;
          }
          return { tag: "draft", promptText: state.attempt.text, errorMessage: event.message };
        }
        default:
          return assertNever(event);
      }
    },
    { tag: "draft", promptText: "", errorMessage: "" }
  );

  const handleFilesDropped = useCallback((files: ImageAttachment[]) => {
    addImagesRef.current?.(files);
  }, []);

  const handleAddImagesCallback = useCallback((addImages: (images: ImageAttachment[]) => void) => {
    addImagesRef.current = addImages;
  }, []);
  const openDropdownSheet = useCallback((key: "host") => {
    setOpenDropdown(key);
  }, []);
  const closeDropdown = useCallback(() => {
    setOpenDropdown(null);
  }, []);
  const sessionAgents = useSessionStore((state) =>
    selectedServerId ? state.sessions[selectedServerId]?.agents : undefined
  );
  const agentWorkingDirSuggestions = useMemo(() => {
    if (!selectedServerId || !sessionAgents) {
      return [];
    }
    const pathLastCreated = new Map<string, Date>();
    sessionAgents.forEach((agent) => {
      if (agent.cwd && !agent.cwd.includes(".paseo/worktrees")) {
        const existing = pathLastCreated.get(agent.cwd);
        if (!existing || agent.createdAt > existing) {
          pathLastCreated.set(agent.cwd, agent.createdAt);
        }
      }
    });
    return Array.from(pathLastCreated.keys()).sort((a, b) => {
      const aTime = pathLastCreated.get(a)!.getTime();
      const bTime = pathLastCreated.get(b)!.getTime();
      return bTime - aTime;
    });
  }, [selectedServerId, sessionAgents]);

  const sessionClient = useSessionStore((state) =>
    selectedServerId ? state.sessions[selectedServerId]?.client ?? null : null
  );
  const isConnected = useSessionStore((state) =>
    selectedServerId
      ? state.sessions[selectedServerId]?.connection.isConnected ?? false
      : false
  );
  const trimmedWorkingDir = workingDir.trim();
  const shouldInspectRepo = trimmedWorkingDir.length > 0;
  const daemonAvailabilityError =
    !selectedServerId || hostEntry?.status !== "online"
      ? "Host is offline"
      : null;
  const repoAvailabilityError =
    shouldInspectRepo && (!hostEntry || hostEntry.status !== "online" || !isConnected)
      ? daemonAvailabilityError ??
        "Repository details will load automatically once the selected host is back online."
      : null;

  const checkoutStatusQuery = useQuery({
    queryKey: checkoutStatusQueryKey(selectedServerId ?? "", trimmedWorkingDir),
    queryFn: async () => {
      const client = sessionClient;
      if (!client) {
        throw new Error("Daemon client unavailable");
      }
      return await client.getCheckoutStatus(trimmedWorkingDir);
    },
    enabled:
      Boolean(selectedServerId) &&
      Boolean(trimmedWorkingDir) &&
      !repoAvailabilityError &&
      Boolean(sessionClient) &&
      isConnected,
    retry: false,
    staleTime: CHECKOUT_STATUS_STALE_TIME,
    refetchOnMount: "always",
  });

  const checkout = checkoutStatusQuery.data ?? null;
  const refetchCheckoutStatus = checkoutStatusQuery.refetch;
  const checkoutQueryError =
    checkoutStatusQuery.error instanceof Error ? checkoutStatusQuery.error.message : null;
  const checkoutPayloadError = checkout?.error ? checkout.error.message : null;

  const isNonGitDirectory =
    Boolean(trimmedWorkingDir) &&
    checkoutStatusQuery.isSuccess &&
    checkout?.isGit === false &&
    checkout?.error == null;

  const isDirectoryNotExists =
    checkoutStatusQuery.isError &&
    /does not exist|no such file or directory|ENOENT/i.test(checkoutQueryError ?? "");

  const repoInfoStatus: "idle" | "loading" | "ready" | "error" = !shouldInspectRepo
    ? "idle"
    : repoAvailabilityError
      ? "error"
      : checkoutStatusQuery.isPending || checkoutStatusQuery.isFetching
        ? "loading"
        : checkoutStatusQuery.isError || Boolean(checkoutPayloadError)
          ? "error"
          : checkout?.isGit
            ? "ready"
            : "idle";

  const repoInfoError =
    repoAvailabilityError ??
    (checkoutStatusQuery.isError ? checkoutQueryError : null) ??
    checkoutPayloadError;
  const isCreateWorktree = worktreeMode === "create";
  const isAttachWorktree = worktreeMode === "attach";

  const worktreeListRoot = checkout?.repoRoot ?? trimmedWorkingDir;
  const worktreeListQuery = useQuery({
    queryKey: ["paseoWorktreeList", selectedServerId, worktreeListRoot],
    queryFn: async () => {
      const client = sessionClient;
      if (!client) {
        throw new Error("Daemon client unavailable");
      }
      const payload = await client.getPaseoWorktreeList({
        repoRoot: worktreeListRoot || undefined,
        cwd: worktreeListRoot ? undefined : trimmedWorkingDir || undefined,
      });
      if (payload.error) {
        throw new Error(payload.error.message);
      }
      return payload.worktrees ?? [];
    },
    enabled:
      isAttachWorktree &&
      Boolean(worktreeListRoot || trimmedWorkingDir) &&
      !repoAvailabilityError &&
      Boolean(sessionClient) &&
      isConnected &&
      !isNonGitDirectory,
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
  });
  const worktreeOptions = useMemo(() => {
    return (worktreeListQuery.data ?? []).map((worktree) => ({
      path: worktree.worktreePath,
      label: worktree.branchName ?? worktree.head ?? "Unknown branch",
    }));
  }, [worktreeListQuery.data]);
  const worktreeOptionsError =
    worktreeListQuery.error instanceof Error ? worktreeListQuery.error.message : null;
  const worktreeOptionsStatus: "idle" | "loading" | "ready" | "error" =
    !isAttachWorktree
      ? "idle"
      : worktreeListQuery.isPending || worktreeListQuery.isFetching
      ? "loading"
      : worktreeListQuery.isError
      ? "error"
      : "ready";
  const attachWorktreeError =
    isAttachWorktree &&
    worktreeOptionsStatus === "ready" &&
    worktreeOptions.length > 0 &&
    !selectedWorktreePath
      ? "Select a worktree to attach"
      : null;

  const handleWorktreeModeChange = useCallback(
    (mode: "none" | "create" | "attach") => {
      setWorktreeMode(mode);
      if (mode === "create" && !worktreeSlug) {
        setWorktreeSlug(createNameId());
      }
      if (mode !== "attach") {
        setSelectedWorktreePath("");
      }
      if (mode !== "none") {
        refetchCheckoutStatus();
      }
    },
    [worktreeSlug, refetchCheckoutStatus]
  );

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

  const gitBlockingError = useMemo(() => {
    if (!isCreateWorktree || isNonGitDirectory) {
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
    isCreateWorktree,
    isNonGitDirectory,
    worktreeSlug,
    validateWorktreeName,
  ]);

  // Validate branch exists (checks local first, then remote)
  const branchValidationQuery = useQuery({
    queryKey: ["validateBranch", selectedServerId, trimmedWorkingDir, baseBranch],
    queryFn: async () => {
      const client = sessionClient;
      if (!client) {
        throw new Error("Daemon client unavailable");
      }
      return client.validateBranch({
        cwd: trimmedWorkingDir || ".",
        branchName: baseBranch,
      });
    },
    enabled:
      isCreateWorktree &&
      !isNonGitDirectory &&
      Boolean(baseBranch) &&
      Boolean(trimmedWorkingDir) &&
      Boolean(sessionClient) &&
      isConnected,
    retry: false,
    staleTime: 30_000,
  });

  const baseBranchError = useMemo(() => {
    if (!isCreateWorktree || isNonGitDirectory) {
      return null;
    }
    if (!baseBranch) {
      return "Base branch is required";
    }
    // While validating, don't show error
    if (branchValidationQuery.isPending || branchValidationQuery.isFetching) {
      return null;
    }
    // If validation query errored, show generic error
    if (branchValidationQuery.isError) {
      return "Failed to validate branch";
    }
    // If validation completed and branch doesn't exist
    const validationResult = branchValidationQuery.data;
    if (validationResult && !validationResult.exists) {
      return `Branch "${baseBranch}" not found in repository`;
    }
    return null;
  }, [isCreateWorktree, isNonGitDirectory, baseBranch, branchValidationQuery]);

  const handleBaseBranchChange = useCallback((value: string) => {
    setBaseBranch(value);
  }, []);

  const handleSelectWorktreePath = useCallback(
    (path: string) => {
      setSelectedWorktreePath(path);
      setWorkingDirFromUser(path);
    },
    [setWorkingDirFromUser]
  );

  useEffect(() => {
    if (!isCreateWorktree || isNonGitDirectory) {
      return;
    }
    if (baseBranch) {
      return;
    }
    const current = checkout?.isGit ? checkout.currentBranch?.trim() : null;
    if (!current || current === "HEAD") {
      return;
    }
    if (current) {
      setBaseBranch(current);
    }
  }, [isCreateWorktree, isNonGitDirectory, baseBranch, checkout]);

  useEffect(() => {
    if (isNonGitDirectory && worktreeMode !== "none") {
      setWorktreeMode("none");
      setSelectedWorktreePath("");
    }
  }, [isNonGitDirectory, worktreeMode]);

  const createAgentClient = useSessionStore((state) =>
    selectedServerId ? state.sessions[selectedServerId]?.client ?? null : null
  );

  const promptValue = machine.tag === "draft" ? machine.promptText : "";
  const formErrorMessage = machine.tag === "draft" ? machine.errorMessage : "";
  const isSubmitting = machine.tag === "creating";

  const optimisticStreamItems = useMemo<StreamItem[]>(() => {
    if (machine.tag !== "creating") {
      return EMPTY_STREAM_ITEMS;
    }
    return [
      {
        kind: "user_message",
        id: machine.attempt.messageId,
        text: machine.attempt.text,
        timestamp: machine.attempt.timestamp,
      },
    ];
  }, [machine]);

  const draftAgent = useMemo<Agent | null>(() => {
    if (machine.tag !== "creating") {
      return null;
    }
    const serverId = selectedServerId ?? "";
    const now = machine.attempt.timestamp;
    const cwd = (isAttachWorktree && selectedWorktreePath ? selectedWorktreePath : workingDir).trim() || ".";
    const provider = selectedProvider;
    const model = selectedModel.trim() || null;
    const modeId = modeOptions.length > 0 && selectedMode !== "" ? selectedMode : null;

    return {
      serverId,
      id: DRAFT_AGENT_ID,
      provider,
      status: "running",
      createdAt: now,
      updatedAt: now,
      lastUserMessageAt: now,
      lastActivityAt: now,
      capabilities: DRAFT_CAPABILITIES,
      currentModeId: modeId,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      runtimeInfo: {
        provider,
        sessionId: null,
        model,
        modeId,
      },
      title: "New agent",
      cwd,
      model,
      labels: {},
    };
  }, [
    machine.tag,
    machine.tag === "creating" ? machine.attempt.timestamp : null,
    isAttachWorktree,
    modeOptions.length,
    selectedMode,
    selectedModel,
    selectedProvider,
    selectedServerId,
    selectedWorktreePath,
    workingDir,
  ]);

  const handleCreateFromInput = useCallback(
    async ({
      text,
      images,
    }: {
      text: string;
      images?: Array<{ uri: string; mimeType: string }>;
    }) => {
      if (isSubmitting) {
        throw new Error("Already loading");
      }
      dispatch({ type: "DRAFT_SET_ERROR", message: "" });
      const trimmedPath = workingDir.trim();
      const trimmedPrompt = text.trim();
      const resolvedWorkingDir =
        isAttachWorktree && selectedWorktreePath
          ? selectedWorktreePath
          : trimmedPath;
      if (!trimmedPath) {
        dispatch({ type: "DRAFT_SET_ERROR", message: "Working directory is required" });
        throw new Error("Working directory is required");
      }
      if (isDirectoryNotExists) {
        dispatch({
          type: "DRAFT_SET_ERROR",
          message: "Working directory does not exist on the selected host",
        });
        throw new Error("Working directory does not exist on the selected host");
      }
      if (!trimmedPrompt) {
        dispatch({ type: "DRAFT_SET_ERROR", message: "Initial prompt is required" });
        throw new Error("Initial prompt is required");
      }
      if (!selectedServerId) {
        dispatch({ type: "DRAFT_SET_ERROR", message: "No host selected" });
        throw new Error("No host selected");
      }
      if (gitBlockingError) {
        dispatch({ type: "DRAFT_SET_ERROR", message: gitBlockingError });
        throw new Error(gitBlockingError);
      }
      if (isAttachWorktree && !selectedWorktreePath) {
        const message = "Select a worktree to attach";
        dispatch({ type: "DRAFT_SET_ERROR", message });
        throw new Error(message);
      }
      if (baseBranchError) {
        dispatch({ type: "DRAFT_SET_ERROR", message: baseBranchError });
        throw new Error(baseBranchError);
      }
      if (!createAgentClient) {
        dispatch({ type: "DRAFT_SET_ERROR", message: "Host is not connected" });
        throw new Error("Host is not connected");
      }
      const attempt = {
        messageId: generateMessageId(),
        text: trimmedPrompt,
        timestamp: new Date(),
      };
      setPendingCreateAttempt({
        serverId: selectedServerId,
        agentId: null,
        messageId: attempt.messageId,
        text: attempt.text,
        timestamp: attempt.timestamp.getTime(),
      });
      const modeId =
        modeOptions.length > 0 && selectedMode !== "" ? selectedMode : undefined;
      const trimmedModel = selectedModel.trim();
      const config: AgentSessionConfig = {
        provider: selectedProvider,
        cwd: resolvedWorkingDir,
        ...(modeId ? { modeId } : {}),
        ...(trimmedModel ? { model: trimmedModel } : {}),
      };
      const effectiveBaseBranch = baseBranch.trim();
      const effectiveWorktreeSlug =
        isCreateWorktree && !worktreeSlug ? createNameId() : worktreeSlug;
      if (isCreateWorktree && !worktreeSlug && effectiveWorktreeSlug) {
        setWorktreeSlug(effectiveWorktreeSlug);
      }
      const gitOptions =
        isCreateWorktree && !isNonGitDirectory && effectiveWorktreeSlug
          ? {
              createWorktree: true,
              createNewBranch: true,
              newBranchName: effectiveWorktreeSlug,
              worktreeSlug: effectiveWorktreeSlug,
              baseBranch: effectiveBaseBranch,
            }
          : undefined;

      void persistFormPreferences();
      if (Platform.OS === "web") {
        (document.activeElement as HTMLElement | null)?.blur?.();
      }
      Keyboard.dismiss();
      dispatch({ type: "SUBMIT", attempt });
      onCreateFlowActiveChange?.(true);

      try {
        const imagesData = await encodeImages(images);
        const result = await createAgentClient.createAgent({
          config,
          labels: { ui: "true" },
          initialPrompt: trimmedPrompt,
          ...(imagesData && imagesData.length > 0 ? { images: imagesData } : {}),
          git: gitOptions,
        });

        const agentId = (result as { id?: string })?.id;
        if (agentId && selectedServerId) {
          updatePendingAgentId(agentId);
          router.replace(`/agent/${selectedServerId}/${agentId}` as any);
          return;
        }

        dispatch({
          type: "CREATE_FAILED",
          message: "Failed to create agent",
        });
        onCreateFlowActiveChange?.(false);
        clearPendingCreateAttempt();
        throw new Error("Failed to create agent");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to create agent";
        dispatch({ type: "CREATE_FAILED", message });
        onCreateFlowActiveChange?.(false);
        clearPendingCreateAttempt();
        throw error; // Re-throw so AgentInputArea knows it failed
      }
    },
    [
      worktreeMode,
      baseBranch,
      worktreeSlug,
      selectedWorktreePath,
      gitBlockingError,
      baseBranchError,
      isDirectoryNotExists,
      isNonGitDirectory,
      modeOptions,
      persistFormPreferences,
      router,
      selectedMode,
      selectedModel,
      selectedProvider,
      selectedServerId,
      createAgentClient,
      setPendingCreateAttempt,
      updatePendingAgentId,
      clearPendingCreateAttempt,
      workingDir,
      isAttachWorktree,
      isSubmitting,
      onCreateFlowActiveChange,
    ]
  );

  if (daemons.length === 0) {
    return (
      <WelcomeScreen
        onHostAdded={(profile) => {
          setSelectedServerIdFromUser(profile.id);
        }}
      />
    );
  }

  return (
    <FileDropZone onFilesDropped={handleFilesDropped}>
      <View style={styles.container}>
        <View style={styles.agentPanel}>
          <MenuHeader
            title="New agent"
            rightContent={
              <Pressable
                style={styles.hostBadge}
                onPress={() => openDropdownSheet("host")}
              >
                <Monitor size={14} color={theme.colors.foregroundMuted} />
                <Text style={styles.hostBadgeLabel}>{hostLabel}</Text>
                <View
                  style={[
                    styles.hostStatusDot,
                    hostEntry?.status === "online" && styles.hostStatusDotOnline,
                  ]}
                />
                {hostStatus ? (
                  <Text style={styles.hostBadgeStatus}>{hostStatus}</Text>
                ) : null}
              </Pressable>
            }
          />

        <Animated.View style={[styles.contentContainer, animatedKeyboardStyle]}>
        {machine.tag === "creating" && draftAgent && selectedServerId ? (
          <View style={styles.streamContainer}>
            <AgentStreamView
              agentId={DRAFT_AGENT_ID}
              serverId={selectedServerId}
              agent={draftAgent}
              streamItems={optimisticStreamItems}
              pendingPermissions={EMPTY_PENDING_PERMISSIONS}
            />
          </View>
        ) : (
        <ScrollView style={styles.scrollView} contentContainerStyle={styles.configScrollContent}>
          <View style={styles.configSection}>
            <WorkingDirectoryDropdown
              workingDir={workingDir}
              errorMessage=""
              disabled={false}
              suggestedPaths={agentWorkingDirSuggestions}
              onSelectPath={setWorkingDirFromUser}
            />
            {isDirectoryNotExists && (
              <View style={styles.warningContainer}>
                <Text style={styles.warningText}>
                  Directory does not exist on the selected host
                </Text>
              </View>
            )}
            <AgentConfigRow
              providerDefinitions={providerDefinitions}
              selectedProvider={selectedProvider}
              onSelectProvider={setProviderFromUser}
              modeOptions={modeOptions}
              selectedMode={selectedMode}
              onSelectMode={setModeFromUser}
              models={availableModels}
              selectedModel={selectedModel}
              isModelLoading={isModelLoading}
              onSelectModel={setModelFromUser}
            />
            {trimmedWorkingDir.length > 0 && !isNonGitDirectory ? (
              <GitOptionsSection
                worktreeMode={worktreeMode}
                onWorktreeModeChange={handleWorktreeModeChange}
                worktreeSlug={worktreeSlug}
                currentBranch={checkout?.isGit ? checkout.currentBranch ?? null : null}
                baseBranch={baseBranch}
                onBaseBranchChange={handleBaseBranchChange}
                status={repoInfoStatus}
                repoError={repoInfoError}
                gitValidationError={gitBlockingError}
                baseBranchError={baseBranchError}
                worktreeOptions={worktreeOptions}
                selectedWorktreePath={selectedWorktreePath}
                worktreeOptionsStatus={worktreeOptionsStatus}
                worktreeOptionsError={worktreeOptionsError}
                attachWorktreeError={attachWorktreeError}
                onSelectWorktreePath={handleSelectWorktreePath}
              />
            ) : null}
          </View>
          <DropdownSheet
            title="Host"
            visible={openDropdown === "host"}
            onClose={closeDropdown}
          >
            {connectionStates.size === 0 ? (
              <Text style={styles.dropdownHelper}>
                No hosts available yet.
              </Text>
            ) : (
              <View style={styles.dropdownSheetList}>
                {Array.from(connectionStates.values()).map(({ daemon, status }) => {
                  const isSelected = daemon.id === selectedServerId;
                  const label = daemon.label ?? daemon.endpoints?.[0] ?? daemon.id;
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
                      <Text style={styles.dropdownSheetOptionLabel}>
                        {label}
                      </Text>
                      <Text style={styles.dropdownSheetOptionDescription}>
                        {formatConnectionStatus(status)}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            )}
          </DropdownSheet>

          {formErrorMessage ? (
            <View style={styles.errorContainer}>
              <Text style={styles.errorText}>{formErrorMessage}</Text>
            </View>
          ) : null}
        </ScrollView>
        )}
        </Animated.View>
        <View style={styles.inputAreaWrapper}>
          <AgentInputArea
            agentId={DRAFT_AGENT_ID}
            serverId={selectedServerId ?? ""}
            onSubmitMessage={handleCreateFromInput}
            isSubmitLoading={isSubmitting}
            blurOnSubmit={true}
            value={promptValue}
            onChangeText={(next) => dispatch({ type: "DRAFT_SET_PROMPT", text: next })}
            autoFocus={machine.tag === "draft"}
            onAddImages={handleAddImagesCallback}
          />
        </View>
      </View>
    </View>
  </FileDropZone>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  agentPanel: {
    flex: 1,
  },
  contentContainer: {
    flex: 1,
    overflow: "hidden",
  },
  scrollView: {
    flex: 1,
  },
  inputAreaWrapper: {
    backgroundColor: theme.colors.surface0,
  },
  streamContainer: {
    flex: 1,
  },
  configScrollContent: {
    flexGrow: 1,
    justifyContent: "flex-end",
  },
  configSection: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[4],
    gap: theme.spacing[2],
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: "center",
    width: "100%",
  },
  dropdownHelper: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  dropdownSheetList: {
    marginTop: theme.spacing[3],
  },
  dropdownSheetOption: {
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
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
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
  },
  errorContainer: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    marginHorizontal: theme.spacing[4],
    marginBottom: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.destructive,
  },
  errorText: {
    color: theme.colors.destructiveForeground,
    fontSize: theme.fontSize.sm,
  },
  warningContainer: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.palette.yellow[400],
  },
  warningText: {
    color: "#000000",
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  hostBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.full,
  },
  hostBadgeLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
  },
  hostBadgeStatus: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  hostStatusDot: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundMuted,
  },
  hostStatusDotOnline: {
    backgroundColor: theme.colors.palette.green[500],
  },
}));
