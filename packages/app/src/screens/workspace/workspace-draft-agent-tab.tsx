import { useCallback, useEffect, useMemo, useRef } from "react";
import { Keyboard, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AgentInputArea } from "@/components/agent-input-area";
import { FileDropZone } from "@/components/file-drop-zone";
import { AgentStreamView } from "@/components/agent-stream-view";
import type { ImageAttachment } from "@/components/message-input";
import { useAgentFormState } from "@/hooks/use-agent-form-state";
import { useAgentInputDraft } from "@/hooks/use-agent-input-draft";
import { useDraftAgentCreateFlow } from "@/hooks/use-draft-agent-create-flow";
import { useDraftAgentFeatures } from "@/hooks/use-draft-agent-features";
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
import { isWeb } from "@/constants/platform";

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
    allProviderEntries,
    isAllModelsLoading,
    availableThinkingOptions,
    isModelLoading,
    setProviderAndModelFromUser,
    invalidateProviderModels,
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

  const effectiveDraftModelId = useMemo(() => {
    if (selectedModel.trim()) {
      return selectedModel.trim();
    }
    return availableModels.find((model) => model.isDefault)?.id ?? availableModels[0]?.id ?? "";
  }, [availableModels, selectedModel]);

  const effectiveDraftThinkingOptionId = useMemo(() => {
    if (selectedThinkingOptionId.trim()) {
      return selectedThinkingOptionId.trim();
    }
    const selectedModelDefinition =
      availableModels.find((model) => model.id === effectiveDraftModelId) ?? null;
    return selectedModelDefinition?.defaultThinkingOptionId ?? "";
  }, [availableModels, effectiveDraftModelId, selectedThinkingOptionId]);
  const {
    features: draftFeatures,
    featureValues: draftFeatureValues,
    setFeatureValue: setDraftFeatureValue,
  } = useDraftAgentFeatures({
    serverId,
    provider: selectedProvider,
    cwd: workspaceId,
    modeId: selectedMode,
    modelId: effectiveDraftModelId,
    thinkingOptionId: effectiveDraftThinkingOptionId,
  });

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
      if (isModelLoading) {
        return "Model defaults are still loading";
      }
      if (!effectiveDraftModelId) {
        return "No model is available for the selected provider";
      }
      if (!client) {
        return "Host is not connected";
      }
      return null;
    },
    onBeforeSubmit: () => {
      void persistFormPreferences();
      if (isWeb) {
        (document.activeElement as HTMLElement | null)?.blur?.();
      }
      Keyboard.dismiss();
    },
    buildDraftAgent: (attempt) => {
      const now = attempt.timestamp;
      const model = effectiveDraftModelId || null;
      const thinkingOptionId = effectiveDraftThinkingOptionId || null;
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
        features: draftFeatures,
        thinkingOptionId,
        labels: {},
      };
    },
    createRequest: async ({ attempt, text, images }) => {
      if (!client) {
        throw new Error("Host is not connected");
      }

      const modeId = modeOptions.length > 0 && selectedMode !== "" ? selectedMode : undefined;
      const config: AgentSessionConfig = {
        provider: selectedProvider,
        cwd: workspaceId,
        ...(modeId ? { modeId } : {}),
        ...(effectiveDraftModelId ? { model: effectiveDraftModelId } : {}),
        ...(effectiveDraftThinkingOptionId
          ? { thinkingOptionId: effectiveDraftThinkingOptionId }
          : {}),
        ...(draftFeatureValues ? { featureValues: draftFeatureValues } : {}),
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
      ...(effectiveDraftModelId ? { model: effectiveDraftModelId } : {}),
      ...(effectiveDraftThinkingOptionId
        ? { thinkingOptionId: effectiveDraftThinkingOptionId }
        : {}),
      ...(draftFeatureValues ? { featureValues: draftFeatureValues } : {}),
    };
  }, [
    draftFeatureValues,
    effectiveDraftModelId,
    effectiveDraftThinkingOptionId,
    modeOptions.length,
    selectedMode,
    selectedProvider,
    workspaceId,
  ]);

  const handleFilesDropped = useCallback((files: ImageAttachment[]) => {
    addImagesRef.current?.(files);
  }, []);

  const handleAddImagesCallback = useCallback((addImages: (images: ImageAttachment[]) => void) => {
    addImagesRef.current = addImages;
  }, []);

  const focusInputRef = useRef<(() => void) | null>(null);

  const handleFocusInputCallback = useCallback((focus: () => void) => {
    focusInputRef.current = focus;
  }, []);

  const handleProviderSelectWithFocus = useCallback(
    (provider: string) => {
      setProviderFromUser(provider);
      focusInputRef.current?.();
    },
    [setProviderFromUser],
  );

  const handleModeSelectWithFocus = useCallback(
    (modeId: string) => {
      setModeFromUser(modeId);
      focusInputRef.current?.();
    },
    [setModeFromUser],
  );

  const handleModelSelectWithFocus = useCallback(
    (modelId: string) => {
      setModelFromUser(modelId);
      focusInputRef.current?.();
    },
    [setModelFromUser],
  );

  const handleProviderAndModelSelectWithFocus = useCallback(
    (provider: string, modelId: string) => {
      setProviderAndModelFromUser(provider, modelId);
      focusInputRef.current?.();
    },
    [setProviderAndModelFromUser],
  );

  const handleThinkingOptionSelectWithFocus = useCallback(
    (optionId: string) => {
      setThinkingOptionFromUser(optionId);
      focusInputRef.current?.();
    },
    [setThinkingOptionFromUser],
  );

  const handleSetFeatureWithFocus = useCallback(
    (featureId: string, value: unknown) => {
      setDraftFeatureValue(featureId, value);
      focusInputRef.current?.();
    },
    [setDraftFeatureValue],
  );

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
            isPaneFocused={isPaneFocused}
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
            onFocusInput={handleFocusInputCallback}
            commandDraftConfig={draftCommandConfig}
            statusControls={{
              providerDefinitions,
              selectedProvider,
              onSelectProvider: handleProviderSelectWithFocus,
              modeOptions,
              selectedMode,
              onSelectMode: handleModeSelectWithFocus,
              models: availableModels,
              selectedModel,
              onSelectModel: handleModelSelectWithFocus,
              isModelLoading,
              allProviderModels,
              isAllModelsLoading,
              onSelectProviderAndModel: handleProviderAndModelSelectWithFocus,
              thinkingOptions: availableThinkingOptions,
              selectedThinkingOptionId,
              onSelectThinkingOption: handleThinkingOptionSelectWithFocus,
              features: draftFeatures,
              onSetFeature: handleSetFeatureWithFocus,
              onDropdownClose: () => focusInputRef.current?.(),
              onModelSelectorOpen: invalidateProviderModels,
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
