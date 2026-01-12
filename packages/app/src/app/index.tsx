import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createNameId } from "mnemonic-id";
import type { ImageAttachment } from "@/components/message-input";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { Monitor } from "lucide-react-native";
import { MenuHeader } from "@/components/headers/menu-header";
import { AgentInputArea } from "@/components/agent-input-area";
import {
  DropdownSheet,
  GitOptionsSection,
  WorkingDirectoryDropdown,
  AgentConfigRow,
} from "@/components/agent-form/agent-form-dropdowns";
import { FileDropZone } from "@/components/file-drop-zone";
import { useQuery } from "@tanstack/react-query";
import { useAgentFormState, type CreateAgentInitialValues } from "@/hooks/use-agent-form-state";
import { useDaemonConnections } from "@/contexts/daemon-connections-context";
import { formatConnectionStatus } from "@/utils/daemons";
import { useSessionStore } from "@/stores/session-store";
import { generateMessageId } from "@/types/stream";
import { MAX_CONTENT_WIDTH } from "@/constants/layout";
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

export default function HomeScreen() {
  const { theme } = useUnistyles();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { connectionStates } = useDaemonConnections();
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
    setModelFromUser(resolvedModel);
  }, [availableModels, resolvedModel, setModelFromUser]);
  const hostEntry = selectedServerId
    ? connectionStates.get(selectedServerId)
    : undefined;
  const hostLabel =
    hostEntry?.daemon.label ?? selectedServerId ?? "Select host";
  const hostStatus = hostEntry?.status
    ? formatConnectionStatus(hostEntry.status)
    : undefined;

  const [openDropdown, setOpenDropdown] = useState<"host" | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [promptText, setPromptText] = useState("");
  const [useWorktree, setUseWorktree] = useState(false);
  const [baseBranch, setBaseBranch] = useState("");
  const [worktreeSlug, setWorktreeSlug] = useState("");
  const addImagesRef = useRef<((images: ImageAttachment[]) => void) | null>(null);

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
    const uniquePaths = new Set<string>();
    sessionAgents.forEach((agent) => {
      if (agent.cwd) {
        uniquePaths.add(agent.cwd);
      }
    });
    return Array.from(uniquePaths).sort();
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

  type RepoInfoState = {
    cwd: string;
    repoRoot: string;
    branches: Array<{ name: string; isCurrent: boolean }>;
    currentBranch: string | null;
    isDirty: boolean;
  };
  const repoInfoQuery = useQuery({
    queryKey: ["gitRepoInfo", selectedServerId, trimmedWorkingDir],
    queryFn: async () => {
      const client = sessionClient;
      if (!client) {
        throw new Error("Daemon client unavailable");
      }
      const payload = await client.getGitRepoInfo({
        cwd: trimmedWorkingDir || ".",
      });
      if (payload.error) {
        throw new Error(payload.error);
      }
      return {
        cwd: payload.cwd,
        repoRoot: payload.repoRoot,
        branches: payload.branches ?? [],
        currentBranch: payload.currentBranch ?? null,
        isDirty: Boolean(payload.isDirty),
      };
    },
    enabled:
      Boolean(trimmedWorkingDir) &&
      !repoAvailabilityError &&
      Boolean(sessionClient) &&
      isConnected,
    retry: false,
  });
  const repoInfo = repoInfoQuery.data ?? null;
  const repoRequestError = repoInfoQuery.error as Error | null;
  const repoRequestStatus: "idle" | "loading" | "success" | "error" =
    !shouldInspectRepo || repoAvailabilityError
      ? "idle"
      : repoInfoQuery.isPending || repoInfoQuery.isFetching
      ? "loading"
      : repoInfoQuery.isError
      ? "error"
      : repoInfoQuery.isSuccess
      ? "success"
      : "idle";
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

  useEffect(() => {
    if (isNonGitDirectory && useWorktree) {
      setUseWorktree(false);
    }
  }, [isNonGitDirectory, useWorktree]);

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
      if (baseBranchError) {
        setErrorMessage(baseBranchError);
        throw new Error(baseBranchError);
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
      const effectiveBaseBranch = baseBranch.trim() || repoInfo?.currentBranch || undefined;
      const gitOptions = useWorktree && !isNonGitDirectory && worktreeSlug
        ? {
            createWorktree: true,
            worktreeSlug,
            baseBranch: effectiveBaseBranch,
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
      useWorktree,
      baseBranch,
      worktreeSlug,
      repoInfo?.currentBranch,
      gitBlockingError,
      baseBranchError,
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
    ]
  );

  useEffect(() => {
    if (!sessionClient) {
      return;
    }
    const unsubscribe = sessionClient.on("status", (message) => {
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
  }, [router, selectedServerId, sessionClient]);

  return (
    <FileDropZone onFilesDropped={handleFilesDropped}>
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

        <Animated.View style={[styles.contentContainer, animatedKeyboardStyle]}>
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

          {errorMessage ? (
            <View style={styles.errorContainer}>
              <Text style={styles.errorText}>{errorMessage}</Text>
            </View>
          ) : null}
        </ScrollView>
        </Animated.View>
        <View style={styles.inputAreaWrapper}>
          <AgentInputArea
            agentId={DRAFT_AGENT_ID}
            serverId={selectedServerId ?? ""}
            onSubmitMessage={handleCreateFromInput}
            isSubmitLoading={isLoading}
            value={promptText}
            onChangeText={setPromptText}
            autoFocus
            onAddImages={handleAddImagesCallback}
          />
        </View>
      </View>

      {isLoading ? (
        <View style={styles.loadingOverlay}>
          <View style={styles.loadingContent}>
            <ActivityIndicator size="large" color={theme.colors.foreground} />
            <Text style={styles.loadingText}>Creating agent...</Text>
          </View>
        </View>
      ) : null}
    </View>
  </FileDropZone>
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
    overflow: "hidden",
  },
  scrollView: {
    flex: 1,
  },
  inputAreaWrapper: {
    backgroundColor: theme.colors.background,
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
  loadingOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0, 0, 0, 0.7)",
    justifyContent: "center",
    alignItems: "center",
  },
  loadingContent: {
    alignItems: "center",
    gap: theme.spacing[4],
  },
  loadingText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
}));
