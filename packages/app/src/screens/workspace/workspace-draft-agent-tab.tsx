import { useCallback, useEffect, useMemo, useRef } from "react";
import { Keyboard, Platform, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AgentInputArea } from "@/components/agent-input-area";
import { FileDropZone } from "@/components/file-drop-zone";
import { AgentStreamView } from "@/components/agent-stream-view";
import type { ImageAttachment } from "@/components/message-input";
import { useAgentFormState } from "@/hooks/use-agent-form-state";
import { useAgentInputDraft } from "@/hooks/use-agent-input-draft";
import { useDraftAgentCreateFlow } from "@/hooks/use-draft-agent-create-flow";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import type { Agent } from "@/stores/session-store";
import { encodeImages } from "@/utils/encode-images";
import { shouldAutoFocusWorkspaceDraftComposer } from "@/screens/workspace/workspace-draft-pane-focus";
import type {
  AgentCapabilityFlags,
  AgentSessionConfig,
} from "@server/server/agent/agent-sdk-types";
import type { AgentSnapshotPayload } from "@server/shared/messages";

const EMPTY_PENDING_PERMISSIONS = new Map();
const DRAFT_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: false,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
};

type WorkspaceDraftAgentTabProps = {
  serverId: string;
  workspaceId: string;
  tabId: string;
  draftId: string;
  isPaneFocused: boolean;
  onCreated: (snapshot: AgentSnapshotPayload) => void;
  onOpenWorkspaceFile: (input: { filePath: string }) => void;
};

export function WorkspaceDraftAgentTab({
  serverId,
  workspaceId,
  tabId,
  draftId,
  isPaneFocused,
  onCreated,
  onOpenWorkspaceFile,
}: WorkspaceDraftAgentTabProps) {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const addImagesRef = useRef<((images: ImageAttachment[]) => void) | null>(null);
  const draftInput = useAgentInputDraft(
    buildDraftStoreKey({
      serverId,
      agentId: tabId,
      draftId,
    }),
  );

  const {
    selectedProvider,
    setProviderFromUser,
    selectedMode,
    setModeFromUser,
    selectedModel,
    setModelFromUser,
    selectedThinkingOptionId,
    setThinkingOptionFromUser,
    workingDir,
    setWorkingDir,
    providerDefinitions,
    modeOptions,
    availableModels,
    allProviderModels,
    isAllModelsLoading,
    availableThinkingOptions,
    isModelLoading,
    setProviderAndModelFromUser,
    persistFormPreferences,
  } = useAgentFormState({
    initialServerId: serverId,
    initialValues: { workingDir: workspaceId },
    isVisible: true,
    isCreateFlow: true,
    onlineServerIds: isConnected ? [serverId] : [],
  });

  // Lock working directory to workspace.
  useEffect(() => {
    if (workingDir.trim() === workspaceId.trim()) {
      return;
    }
    setWorkingDir(workspaceId);
  }, [setWorkingDir, workingDir, workspaceId]);

  const {
    formErrorMessage,
    isSubmitting,
    optimisticStreamItems,
    draftAgent,
    handleCreateFromInput,
  } = useDraftAgentCreateFlow<Agent, AgentSnapshotPayload>({
    draftId,
    getPendingServerId: () => serverId,
    validateBeforeSubmit: ({ text }) => {
      if (!text.trim()) {
        return "Initial prompt is required";
      }
      if (providerDefinitions.length === 0) {
        return "No available providers on the selected host";
      }
      if (!client) {
        return "Host is not connected";
      }
      return null;
    },
    onBeforeSubmit: () => {
      void persistFormPreferences();
      if (Platform.OS === "web") {
        (document.activeElement as HTMLElement | null)?.blur?.();
      }
      Keyboard.dismiss();
    },
    buildDraftAgent: (attempt) => {
      const now = attempt.timestamp;
      const model = selectedModel.trim() || null;
      const thinkingOptionId = selectedThinkingOptionId.trim() || null;
      const modeId = modeOptions.length > 0 && selectedMode !== "" ? selectedMode : null;
      return {
        serverId,
        id: tabId,
        provider: selectedProvider,
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
        runtimeInfo: { provider: selectedProvider, sessionId: null, model, modeId },
        title: "Agent",
        cwd: workspaceId,
        model,
        thinkingOptionId,
        labels: {},
      };
    },
    createRequest: async ({ attempt, text, images }) => {
      if (!client) {
        throw new Error("Host is not connected");
      }

      const modeId = modeOptions.length > 0 && selectedMode !== "" ? selectedMode : undefined;
      const trimmedModel = selectedModel.trim();
      const trimmedThinkingOptionId = selectedThinkingOptionId.trim();
      const config: AgentSessionConfig = {
        provider: selectedProvider,
        cwd: workspaceId,
        ...(modeId ? { modeId } : {}),
        ...(trimmedModel ? { model: trimmedModel } : {}),
        ...(trimmedThinkingOptionId ? { thinkingOptionId: trimmedThinkingOptionId } : {}),
      };

      const imagesData = await encodeImages(images);
      const result = await client.createAgent({
        config,
        initialPrompt: text,
        clientMessageId: attempt.clientMessageId,
        ...(imagesData && imagesData.length > 0 ? { images: imagesData } : {}),
      });

      return {
        agentId: result.id,
        result,
      };
    },
    onCreateSuccess: ({ result }) => {
      onCreated(result);
    },
  });

  const draftCommandConfig = useMemo(() => {
    return {
      provider: selectedProvider,
      cwd: workspaceId,
      ...(modeOptions.length > 0 && selectedMode !== "" ? { modeId: selectedMode } : {}),
      ...(selectedModel.trim() ? { model: selectedModel.trim() } : {}),
      ...(selectedThinkingOptionId.trim()
        ? { thinkingOptionId: selectedThinkingOptionId.trim() }
        : {}),
    };
  }, [
    modeOptions.length,
    selectedMode,
    selectedModel,
    selectedProvider,
    selectedThinkingOptionId,
    workspaceId,
  ]);

  const handleFilesDropped = useCallback((files: ImageAttachment[]) => {
    addImagesRef.current?.(files);
  }, []);

  const handleAddImagesCallback = useCallback((addImages: (images: ImageAttachment[]) => void) => {
    addImagesRef.current = addImages;
  }, []);

  return (
    <FileDropZone onFilesDropped={handleFilesDropped}>
      <View style={styles.container}>
        <View style={styles.contentContainer}>
          {isSubmitting && draftAgent ? (
            <View style={styles.streamContainer}>
              <AgentStreamView
                agentId={tabId}
                serverId={serverId}
                agent={draftAgent}
                streamItems={optimisticStreamItems}
                pendingPermissions={EMPTY_PENDING_PERMISSIONS}
                onOpenWorkspaceFile={onOpenWorkspaceFile}
              />
            </View>
          ) : (
            <ScrollView
              style={styles.scrollView}
              contentContainerStyle={styles.configScrollContent}
            >
              <View style={styles.configSection}>
                {formErrorMessage ? (
                  <View style={styles.errorContainer}>
                    <Text style={styles.errorText}>{formErrorMessage}</Text>
                  </View>
                ) : null}
              </View>
            </ScrollView>
          )}
        </View>

        <View style={styles.inputAreaWrapper}>
          <AgentInputArea
            agentId={tabId}
            serverId={serverId}
            onSubmitMessage={handleCreateFromInput}
            isSubmitLoading={isSubmitting}
            blurOnSubmit={true}
            value={draftInput.text}
            onChangeText={draftInput.setText}
            images={draftInput.images}
            onChangeImages={draftInput.setImages}
            clearDraft={draftInput.clear}
            autoFocus={shouldAutoFocusWorkspaceDraftComposer({ isPaneFocused, isSubmitting })}
            onAddImages={handleAddImagesCallback}
            commandDraftConfig={draftCommandConfig}
            statusControls={{
              providerDefinitions,
              selectedProvider,
              onSelectProvider: setProviderFromUser,
              modeOptions,
              selectedMode,
              onSelectMode: setModeFromUser,
              models: availableModels,
              selectedModel,
              onSelectModel: setModelFromUser,
              isModelLoading,
              allProviderModels,
              isAllModelsLoading,
              onSelectProviderAndModel: setProviderAndModelFromUser,
              thinkingOptions: availableThinkingOptions,
              selectedThinkingOptionId,
              onSelectThinkingOption: setThinkingOptionFromUser,
              disabled: isSubmitting,
            }}
          />
        </View>
      </View>
    </FileDropZone>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    width: "100%",
    backgroundColor: theme.colors.surface0,
  },
  contentContainer: {
    flex: 1,
  },
  streamContainer: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  configScrollContent: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[6],
  },
  configSection: {
    gap: theme.spacing[3],
  },
  inputAreaWrapper: {
    width: "100%",
    backgroundColor: theme.colors.surface0,
  },
  errorContainer: {
    marginTop: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.destructive,
  },
  errorText: {
    color: theme.colors.destructive,
  },
}));
