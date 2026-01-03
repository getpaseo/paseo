import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ChevronRight, Monitor } from "lucide-react-native";
import { MenuHeader } from "@/components/headers/menu-header";
import { AgentInputArea } from "@/components/agent-input-area";
import {
  DropdownSheet,
  GitOptionsSection,
  WorkingDirectoryDropdown,
} from "@/components/agent-form/agent-form-dropdowns";
import { useDaemonRequest } from "@/hooks/use-daemon-request";
import type { SessionOutboundMessage } from "@server/server/messages";
import { useAgentFormState, type CreateAgentInitialValues } from "@/hooks/use-agent-form-state";
import { useDaemonConnections } from "@/contexts/daemon-connections-context";
import { formatConnectionStatus } from "@/utils/daemons";
import { useSessionStore } from "@/stores/session-store";
import { generateMessageId } from "@/types/stream";
import type {
  AgentProvider,
  AgentSessionConfig,
} from "@server/server/agent/agent-sdk-types";
import { AGENT_PROVIDER_DEFINITIONS } from "@server/server/agent/provider-manifest";

const DRAFT_AGENT_ID = "__new_agent__";
const PROVIDER_DEFINITION_MAP = new Map(
  AGENT_PROVIDER_DEFINITIONS.map((definition) => [definition.id, definition])
);

function getParamValue(value: string | string[] | undefined) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
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

type ConfigRowProps = {
  label: string;
  value: string;
  meta?: string;
  onPress: () => void;
  disabled?: boolean;
};

export default function HomeScreen() {
  const { theme } = useUnistyles();
  const router = useRouter();
  const { connectionStates } = useDaemonConnections();
  const params = useLocalSearchParams<DraftAgentParams>();

  const resolvedServerId = getParamValue(params.serverId);
  const resolvedProvider = getValidProvider(getParamValue(params.provider));
  const resolvedMode = getValidMode(resolvedProvider, getParamValue(params.modeId));
  const resolvedModel = getParamValue(params.model);
  const resolvedWorkingDir = getParamValue(params.workingDir);

  const initialValues = useMemo(() => {
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
    return values;
  }, [resolvedMode, resolvedProvider, resolvedWorkingDir]);
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
    userEditedPreferencesRef,
  } = useAgentFormState({
    initialServerId: resolvedServerId ?? null,
    initialValues,
    isVisible: true,
    isCreateFlow: true,
  });
  const hasAppliedModelParamRef = useRef(false);
  useEffect(() => {
    if (!resolvedModel || hasAppliedModelParamRef.current) {
      return;
    }
    if (availableModels.length === 0) {
      return;
    }
    const isValidModel = availableModels.some((model) => model.id === resolvedModel);
    hasAppliedModelParamRef.current = true;
    if (!isValidModel) {
      return;
    }
    if (userEditedPreferencesRef.current.model) {
      return;
    }
    setModelFromUser(resolvedModel);
  }, [availableModels, resolvedModel, setModelFromUser, userEditedPreferencesRef]);
  const hostEntry = selectedServerId
    ? connectionStates.get(selectedServerId)
    : undefined;
  const hostLabel =
    hostEntry?.daemon.label ?? selectedServerId ?? "Select host";
  const hostStatus = hostEntry?.status
    ? formatConnectionStatus(hostEntry.status)
    : undefined;

  const [openDropdown, setOpenDropdown] = useState<
    "host" | "provider" | "mode" | "model" | "workingDir" | "baseBranch" | "agent" | null
  >(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [promptText, setPromptText] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [isolationMode, setIsolationMode] = useState<"none" | "branch" | "worktree">("none");
  const [branchName, setBranchName] = useState("");
  const [worktreeSlug, setWorktreeSlug] = useState("");
  const [branchNameEdited, setBranchNameEdited] = useState(false);
  const [worktreeSlugEdited, setWorktreeSlugEdited] = useState(false);
  const shouldSyncBaseBranchRef = useRef(true);
  const createNewBranch = isolationMode === "branch" || isolationMode === "worktree";
  const createWorktree = isolationMode === "worktree";
  const openDropdownSheet = useCallback(
    (key: "host" | "provider" | "mode" | "model" | "workingDir" | "baseBranch" | "agent") => {
      setOpenDropdown(key);
    },
    []
  );
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
    const uniquePaths = new Set<string>();
    sessionAgents.forEach((agent) => {
      if (agent.cwd) {
        uniquePaths.add(agent.cwd);
      }
    });
    return Array.from(uniquePaths).sort();
  }, [selectedServerId, sessionAgents]);

  const sessionWs = useSessionStore((state) =>
    selectedServerId ? state.sessions[selectedServerId]?.ws : undefined
  );
  const inertWebSocket = useMemo(
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
  const effectiveWs = sessionWs ?? inertWebSocket;
  const isWsConnected = effectiveWs.getConnectionState
    ? effectiveWs.getConnectionState().isConnected
    : effectiveWs.isConnected;

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

  const trimmedWorkingDir = workingDir.trim();
  const shouldInspectRepo = trimmedWorkingDir.length > 0;
  const daemonAvailabilityError =
    !selectedServerId || hostEntry?.status !== "online"
      ? "Host is offline"
      : null;
  const repoAvailabilityError =
    shouldInspectRepo && (!hostEntry || hostEntry.status !== "online" || !isWsConnected)
      ? daemonAvailabilityError ??
        "Repository details will load automatically once the selected host is back online."
      : null;
  const isNonGitDirectory =
    repoRequestStatus === "error" &&
    /not in a git repository/i.test(repoRequestError?.message ?? "");
  const isDirectoryNotExists =
    repoRequestStatus === "error" &&
    /does not exist|no such file or directory|ENOENT/i.test(repoRequestError?.message ?? "");
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
  const repoInfoError =
    repoAvailabilityError ?? (isNonGitDirectory ? null : repoRequestError?.message ?? null);
  const gitHelperText = isNonGitDirectory
    ? "No git repository detected. Git options are disabled for this directory."
    : null;

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
      isolationMode !== "none" ||
      baseBranch.trim().length > 0 ||
      branchName.trim().length > 0 ||
      worktreeSlug.trim().length > 0
    ) {
      setIsolationMode("none");
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
    isolationMode,
    isNonGitDirectory,
    worktreeSlug,
  ]);

  const handleBaseBranchChange = useCallback((value: string) => {
    setBaseBranch(value);
    shouldSyncBaseBranchRef.current = false;
  }, []);

  const renderConfigRow = useCallback(
    ({ label, value, meta, onPress, disabled }: ConfigRowProps) => (
      <Pressable
        style={[styles.configRow, disabled && styles.configRowDisabled]}
        onPress={onPress}
        disabled={disabled}
      >
        <View style={styles.configTextGroup}>
          <Text style={styles.configLabel}>{label}</Text>
          <Text style={styles.configValue} numberOfLines={1}>
            {value}
          </Text>
          {meta ? <Text style={styles.configMeta}>{meta}</Text> : null}
        </View>
        <ChevronRight size={18} color={theme.colors.mutedForeground} />
      </Pressable>
    ),
    [theme.colors.mutedForeground]
  );
  const renderDropdownTrigger = useCallback(
    ({
      label,
      value,
      placeholder,
      onPress,
      disabled,
    }: {
      label: string;
      value: string;
      placeholder: string;
      onPress: () => void;
      disabled?: boolean;
    }) =>
      renderConfigRow({
        label,
        value: value || placeholder,
        onPress,
        disabled,
      }),
    [renderConfigRow]
  );

  const pendingRequestIdRef = useRef<string | null>(null);
  const sessionMethods = useSessionStore((state) =>
    selectedServerId ? state.sessions[selectedServerId]?.methods : undefined
  );

  const handleCreateFromInput = useCallback(
    async ({
      text,
      images,
    }: {
      text: string;
      images?: Array<{ uri: string; mimeType: string }>;
    }) => {
      setErrorMessage("");
      const trimmedPath = workingDir.trim();
      const trimmedPrompt = text.trim();
      if (!trimmedPath) {
        setErrorMessage("Working directory is required");
        throw new Error("Working directory is required");
      }
      if (isDirectoryNotExists) {
        setErrorMessage("Working directory does not exist on the selected host");
        throw new Error("Working directory does not exist on the selected host");
      }
      if (!trimmedPrompt) {
        setErrorMessage("Initial prompt is required");
        throw new Error("Initial prompt is required");
      }
      if (!selectedServerId) {
        setErrorMessage("No host selected");
        throw new Error("No host selected");
      }
      if (gitBlockingError) {
        setErrorMessage(gitBlockingError);
        throw new Error(gitBlockingError);
      }
      if (isLoading) {
        throw new Error("Already loading");
      }
      const createAgent = sessionMethods?.createAgent;
      if (!createAgent) {
        setErrorMessage("Host is not connected");
        throw new Error("Host is not connected");
      }
      const modeId =
        modeOptions.length > 0 && selectedMode !== "" ? selectedMode : undefined;
      const trimmedModel = selectedModel.trim();
      const config: AgentSessionConfig = {
        provider: selectedProvider,
        cwd: trimmedPath,
        ...(modeId ? { modeId } : {}),
        ...(trimmedModel ? { model: trimmedModel } : {}),
      };
      const trimmedBaseBranch = baseBranch.trim();
      const shouldIncludeBase =
        trimmedBaseBranch.length > 0 ||
        createNewBranch ||
        createWorktree;
      const gitOptions =
        shouldIncludeBase && !isNonGitDirectory
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

      void persistFormPreferences();

      const requestId = generateMessageId();
      pendingRequestIdRef.current = requestId;
      setIsLoading(true);
      createAgent({
        config,
        initialPrompt: trimmedPrompt,
        images,
        git: gitOptions,
        requestId,
      });
    },
    [
      baseBranch,
      branchName,
      createNewBranch,
      createWorktree,
      gitBlockingError,
      isDirectoryNotExists,
      isLoading,
      isNonGitDirectory,
      modeOptions,
      persistFormPreferences,
      selectedMode,
      selectedModel,
      selectedProvider,
      selectedServerId,
      sessionMethods,
      workingDir,
      worktreeSlug,
    ]
  );

  useEffect(() => {
    if (!sessionWs) {
      return;
    }
    const unsubscribe = sessionWs.on("status", (message) => {
      if (message.type !== "status") {
        return;
      }
      const payload = message.payload as {
        status: string;
        agentId?: string;
        requestId?: string;
        error?: string;
      };
      const expectedRequestId = pendingRequestIdRef.current;
      if (!expectedRequestId || payload.requestId !== expectedRequestId) {
        return;
      }
      if (payload.status === "agent_create_failed") {
        pendingRequestIdRef.current = null;
        setIsLoading(false);
        setErrorMessage(payload.error ?? "Failed to create agent");
        return;
      }
      if (payload.status !== "agent_created" || !payload.agentId) {
        return;
      }
      if (!selectedServerId) {
        pendingRequestIdRef.current = null;
        setIsLoading(false);
        return;
      }
      pendingRequestIdRef.current = null;
      setIsLoading(false);
      setPromptText("");
      router.replace({
        pathname: "/agent/[serverId]/[agentId]",
        params: {
          serverId: selectedServerId,
          agentId: payload.agentId,
        },
      });
    });

    return () => {
      unsubscribe();
    };
  }, [router, selectedServerId, sessionWs]);

  const selectedProviderLabel =
    providerDefinitions.find((provider) => provider.id === selectedProvider)?.label ??
    selectedProvider;
  const selectedModeLabel =
    modeOptions.length > 0
      ? modeOptions.find((mode) => mode.id === selectedMode)?.label ??
        modeOptions[0]?.label ??
        "Default"
      : "Automatic";

  return (
    <View style={styles.container}>
      <View style={styles.agentPanel}>
        <MenuHeader
          title="New Agent"
          rightContent={
            <Pressable
              style={styles.hostBadge}
              onPress={() => openDropdownSheet("host")}
            >
              <Monitor size={14} color={theme.colors.mutedForeground} />
              <Text style={styles.hostBadgeLabel}>{hostLabel}</Text>
              <View
                style={[
                  styles.hostStatusDot,
                  hostEntry?.status === "online" && styles.hostStatusDotOnline,
                ]}
              />
            </Pressable>
          }
        />

        <ScrollView style={styles.contentContainer} contentContainerStyle={styles.configScrollContent}>
          <View style={styles.configSection}>
            <WorkingDirectoryDropdown
              workingDir={workingDir}
              errorMessage=""
              isOpen={openDropdown === "workingDir"}
              onOpen={() => openDropdownSheet("workingDir")}
              onClose={closeDropdown}
              disabled={false}
              suggestedPaths={agentWorkingDirSuggestions}
              onSelectPath={setWorkingDirFromUser}
              label="Working Directory"
              wrapInContainer={false}
              renderTrigger={renderDropdownTrigger}
            />
            {isDirectoryNotExists && (
              <View style={styles.warningContainer}>
                <Text style={styles.warningText}>
                  Directory does not exist on the selected host
                </Text>
              </View>
            )}
            {renderConfigRow({
              label: "Agent",
              value: `${selectedProviderLabel} · ${selectedModel || "auto"} · ${selectedModeLabel}`,
              onPress: () => openDropdownSheet("agent"),
            })}
            {trimmedWorkingDir.length > 0 && !isNonGitDirectory ? (
              <GitOptionsSection
                baseBranch={baseBranch}
                onBaseBranchChange={handleBaseBranchChange}
                branches={repoInfo?.branches ?? []}
                status={repoInfoStatus}
                repoError={repoInfoError}
                helperText={gitHelperText}
                isGitDisabled={Boolean(gitHelperText)}
                warning={
                  repoInfo?.isDirty
                    ? "Working directory has uncommitted changes"
                    : null
                }
                isolationMode={isolationMode}
                onIsolationModeChange={(mode) => {
                  setIsolationMode(mode);
                  if (mode === "none") {
                    setBranchName("");
                    setWorktreeSlug("");
                    setBranchNameEdited(false);
                    setWorktreeSlugEdited(false);
                  } else if (mode === "branch") {
                    if (!branchNameEdited) {
                      const slug = slugifyWorktreeName(baseBranch || "");
                      setBranchName(slug);
                    }
                  } else if (mode === "worktree") {
                    if (!worktreeSlugEdited) {
                      const slug = slugifyWorktreeName(
                        branchName || baseBranch || ""
                      );
                      setWorktreeSlug(slug);
                    }
                  }
                }}
                branchName={branchName}
                onBranchNameChange={(value) => {
                  setBranchName(slugifyWorktreeName(value));
                  setBranchNameEdited(true);
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

          <DropdownSheet
            title="Agent"
            visible={openDropdown === "agent"}
            onClose={closeDropdown}
          >
            <View style={styles.agentSheetSection}>
              <Text style={styles.agentSheetSectionLabel}>Provider</Text>
              <View style={styles.dropdownSheetList}>
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
                        setProviderFromUser(definition.id);
                      }}
                    >
                      <Text style={styles.dropdownSheetOptionLabel}>
                        {definition.label}
                      </Text>
                      {definition.description ? (
                        <Text style={styles.dropdownSheetOptionDescription}>
                          {definition.description}
                        </Text>
                      ) : null}
                    </Pressable>
                  );
                })}
              </View>
            </View>

            <View style={styles.agentSheetSection}>
              <Text style={styles.agentSheetSectionLabel}>Model</Text>
              <View style={styles.dropdownSheetList}>
                <Pressable
                  style={[
                    styles.dropdownSheetOption,
                    !selectedModel && styles.dropdownSheetOptionSelected,
                  ]}
                  onPress={() => setModelFromUser("")}
                >
                  <Text style={styles.dropdownSheetOptionLabel}>
                    Automatic (provider default)
                  </Text>
                </Pressable>
                {availableModels.map((model) => {
                  const isSelected = model.id === selectedModel;
                  return (
                    <Pressable
                      key={model.id}
                      style={[
                        styles.dropdownSheetOption,
                        isSelected && styles.dropdownSheetOptionSelected,
                      ]}
                      onPress={() => setModelFromUser(model.id)}
                    >
                      <Text style={styles.dropdownSheetOptionLabel}>
                        {model.label}
                      </Text>
                      {model.description ? (
                        <Text style={styles.dropdownSheetOptionDescription}>
                          {model.description}
                        </Text>
                      ) : null}
                    </Pressable>
                  );
                })}
              </View>
            </View>

            {modeOptions.length > 0 ? (
              <View style={styles.agentSheetSection}>
                <Text style={styles.agentSheetSectionLabel}>Mode</Text>
                <View style={styles.dropdownSheetList}>
                  {modeOptions.map((mode) => {
                    const isSelected = mode.id === selectedMode;
                    return (
                      <Pressable
                        key={mode.id}
                        style={[
                          styles.dropdownSheetOption,
                          isSelected && styles.dropdownSheetOptionSelected,
                        ]}
                        onPress={() => setModeFromUser(mode.id)}
                      >
                        <Text style={styles.dropdownSheetOptionLabel}>
                          {mode.label}
                        </Text>
                        {mode.description ? (
                          <Text style={styles.dropdownSheetOptionDescription}>
                            {mode.description}
                          </Text>
                        ) : null}
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            ) : null}
          </DropdownSheet>

          {errorMessage ? (
            <View style={styles.errorContainer}>
              <Text style={styles.errorText}>{errorMessage}</Text>
            </View>
          ) : null}
        </ScrollView>
        <View style={styles.inputAreaWrapper}>
          <AgentInputArea
            agentId={DRAFT_AGENT_ID}
            serverId={selectedServerId ?? ""}
            onSubmitMessage={handleCreateFromInput}
            isSubmitLoading={isLoading}
            value={promptText}
            onChangeText={setPromptText}
            autoFocus
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  agentPanel: {
    flex: 1,
  },
  contentContainer: {
    flex: 1,
  },
  inputAreaWrapper: {
    backgroundColor: theme.colors.background,
  },
  configScrollContent: {
    flexGrow: 1,
  },
  configSection: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[4],
    gap: theme.spacing[2],
  },
  configRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.card,
  },
  configRowDisabled: {
    opacity: theme.opacity[50],
  },
  configTextGroup: {
    flex: 1,
    gap: theme.spacing[1],
    marginRight: theme.spacing[2],
  },
  configLabel: {
    fontSize: theme.fontSize.xs,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    color: theme.colors.mutedForeground,
  },
  configValue: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  configMeta: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.mutedForeground,
  },
  dropdownHelper: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.mutedForeground,
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
  agentSheetSection: {
    marginBottom: theme.spacing[4],
  },
  agentSheetSectionLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    marginBottom: theme.spacing[2],
  },
}));
