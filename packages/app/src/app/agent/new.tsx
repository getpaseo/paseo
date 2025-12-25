import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  Pressable,
  useWindowDimensions,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ChevronRight, Plus } from "lucide-react-native";
import { BackHeader } from "@/components/headers/back-header";
import { AgentList } from "@/components/agent-list";
import { AgentInputArea } from "@/components/agent-input-area";
import {
  AssistantDropdown,
  DropdownSheet,
  ModelDropdown,
  PermissionsDropdown,
  WorkingDirectoryDropdown,
} from "@/components/agent-form/agent-form-dropdowns";
import { useAggregatedAgents } from "@/hooks/use-aggregated-agents";
import { useAgentFormState } from "@/hooks/use-agent-form-state";
import { useDaemonConnections } from "@/contexts/daemon-connections-context";
import { formatConnectionStatus } from "@/utils/daemons";
import { useSessionStore } from "@/stores/session-store";
import { generateMessageId } from "@/types/stream";
import type {
  AgentProvider,
  AgentSessionConfig,
} from "@server/server/agent/agent-sdk-types";

const SIDEBAR_WIDTH = 280;
const LARGE_SCREEN_BREAKPOINT = 768;
const DRAFT_AGENT_ID = "__new_agent__";

function getParamValue(value: string | string[] | undefined) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
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

export default function DraftAgentScreen() {
  const { theme } = useUnistyles();
  const router = useRouter();
  const { width: windowWidth } = useWindowDimensions();
  const isLargeScreen = windowWidth >= LARGE_SCREEN_BREAKPOINT;
  const { agents: aggregatedAgents, isRevalidating, refreshAll } =
    useAggregatedAgents();
  const { connectionStates } = useDaemonConnections();
  const params = useLocalSearchParams<DraftAgentParams>();

  const resolvedServerId = getParamValue(params.serverId);
  const resolvedProvider = getParamValue(params.provider);
  const resolvedMode = getParamValue(params.modeId);
  const resolvedModel = getParamValue(params.model);
  const resolvedWorkingDir = getParamValue(params.workingDir);

  const initialValues = useMemo(
    () => ({
      workingDir: resolvedWorkingDir,
      provider: resolvedProvider
        ? (resolvedProvider as AgentProvider)
        : undefined,
      modeId: resolvedMode ?? null,
      model: resolvedModel ?? null,
    }),
    [resolvedMode, resolvedModel, resolvedProvider, resolvedWorkingDir]
  );
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
  } = useAgentFormState({
    initialServerId: resolvedServerId ?? null,
    initialValues,
    isVisible: true,
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

  const [openDropdown, setOpenDropdown] = useState<
    "host" | "provider" | "mode" | "model" | "workingDir" | null
  >(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const openDropdownSheet = useCallback(
    (key: "host" | "provider" | "mode" | "model" | "workingDir") => {
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

  const handleBackToHome = useCallback(() => {
    router.replace("/");
  }, [router]);

  const handleCreateNewAgent = useCallback(() => {
    router.push("/agent/new");
  }, [router]);
  const pendingRequestIdRef = useRef<string | null>(null);
  const sessionMethods = useSessionStore((state) =>
    selectedServerId ? state.sessions[selectedServerId]?.methods : undefined
  );
  const sessionWs = useSessionStore((state) =>
    selectedServerId ? state.sessions[selectedServerId]?.ws : undefined
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
        return;
      }
      if (!trimmedPrompt) {
        setErrorMessage("Initial prompt is required");
        return;
      }
      if (!selectedServerId) {
        setErrorMessage("No host selected");
        return;
      }
      if (isLoading) {
        return;
      }
      const createAgent = sessionMethods?.createAgent;
      if (!createAgent) {
        setErrorMessage("Host is not connected");
        return;
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
      // TODO: Images in initial agent creation are not yet supported by the server API.
      // For now we log a warning. Images can be sent after agent creation via sendAgentMessage.
      if (images && images.length > 0) {
        console.warn("[DraftAgentScreen] Image attachments on agent creation not yet supported");
      }
      const requestId = generateMessageId();
      pendingRequestIdRef.current = requestId;
      setIsLoading(true);
      createAgent({
        config,
        initialPrompt: trimmedPrompt,
        requestId,
      });
    },
    [
      isLoading,
      modeOptions,
      selectedMode,
      selectedModel,
      selectedProvider,
      selectedServerId,
      sessionMethods,
      workingDir,
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
      router.push({
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

  return (
    <View style={styles.container}>
      <View style={[styles.mainLayout, isLargeScreen && styles.mainLayoutRow]}>
        {isLargeScreen && (
          <View style={[styles.sidebar, { width: SIDEBAR_WIDTH }]}>
            <View style={styles.sidebarHeader}>
              <Pressable
                style={[
                  styles.newAgentButton,
                  { backgroundColor: theme.colors.primary },
                ]}
                onPress={handleCreateNewAgent}
              >
                <Plus size={18} color={theme.colors.primaryForeground} />
                <Text
                  style={[
                    styles.newAgentButtonText,
                    { color: theme.colors.primaryForeground },
                  ]}
                >
                  New Agent
                </Text>
              </Pressable>
            </View>
            <AgentList
              agents={aggregatedAgents}
              isRefreshing={isRevalidating}
              onRefresh={refreshAll}
            />
          </View>
        )}

        <View style={styles.agentPanel}>
          <BackHeader title="New Agent" onBack={handleBackToHome} />

          <View style={styles.contentContainer}>
            <View style={styles.configSection}>
              {renderConfigRow({
                label: "Host",
                value: hostLabel,
                meta: hostStatus,
                onPress: () => openDropdownSheet("host"),
              })}
              <AssistantDropdown
                providerDefinitions={providerDefinitions}
                disabled={false}
                selectedProvider={selectedProvider}
                isOpen={openDropdown === "provider"}
                onOpen={() => openDropdownSheet("provider")}
                onClose={closeDropdown}
                onSelect={setProviderFromUser}
                label="Provider"
                placeholder="Select provider"
                sheetTitle="Choose Provider"
                wrapInContainer={false}
                renderTrigger={renderDropdownTrigger}
              />
              <PermissionsDropdown
                disabled={false}
                modeOptions={modeOptions}
                selectedMode={selectedMode}
                isOpen={openDropdown === "mode"}
                onOpen={() => openDropdownSheet("mode")}
                onClose={closeDropdown}
                onSelect={setModeFromUser}
                label="Mode"
                placeholder="Select mode"
                sheetTitle="Mode"
                wrapInContainer={false}
                renderTrigger={renderDropdownTrigger}
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
                onSelect={setModelFromUser}
                onClear={() => setModelFromUser("")}
                onRefresh={refreshProviderModels}
                label="Model"
                wrapInContainer={false}
                renderTrigger={renderDropdownTrigger}
              />
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
            <View style={styles.streamContainer} />
          </View>
          <AgentInputArea
            agentId={DRAFT_AGENT_ID}
            serverId={selectedServerId ?? ""}
            onSubmitMessage={handleCreateFromInput}
            isSubmitLoading={isLoading}
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
  mainLayout: {
    flex: 1,
  },
  mainLayoutRow: {
    flexDirection: "row",
  },
  sidebar: {
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  sidebarHeader: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[2],
  },
  newAgentButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
  },
  newAgentButtonText: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  agentPanel: {
    flex: 1,
  },
  contentContainer: {
    flex: 1,
  },
  configSection: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[2],
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
  streamContainer: {
    flex: 1,
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
}));
