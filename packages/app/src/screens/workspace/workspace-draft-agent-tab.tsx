import { useCallback, useEffect, useMemo, useRef } from "react";
import { Keyboard, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import invariant from "tiny-invariant";
import { Composer } from "@/components/composer";
import { FileDropZone } from "@/components/file-drop-zone";
import { AgentStreamView } from "@/components/agent-stream-view";
import type { ImageAttachment } from "@/components/message-input";
import { useAgentInputDraft } from "@/hooks/use-agent-input-draft";
import { useDraftAgentCreateFlow } from "@/hooks/use-draft-agent-create-flow";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { buildWorkspaceDraftAgentConfig } from "@/screens/workspace/workspace-draft-agent-config";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import type { Agent } from "@/stores/session-store";
import { useWorkspaceExecutionAuthority } from "@/stores/session-store-hooks";
import { useWorkspaceDraftSubmissionStore } from "@/stores/workspace-draft-submission-store";
import { encodeImages } from "@/utils/encode-images";
import { shouldAutoFocusWorkspaceDraftComposer } from "@/screens/workspace/workspace-draft-pane-focus";
import type { AgentCapabilityFlags } from "@server/server/agent/agent-sdk-types";
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
  const insets = useSafeAreaInsets();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const workspaceAuthority = useWorkspaceExecutionAuthority(serverId, workspaceId);
  const workspaceExecutionAuthority = workspaceAuthority?.ok ? workspaceAuthority.authority : null;
  const workspaceDirectory = workspaceExecutionAuthority?.workspaceDirectory ?? null;
  const addImagesRef = useRef<((images: ImageAttachment[]) => void) | null>(null);
  const draftStoreKey = useMemo(
    () =>
      buildDraftStoreKey({
        serverId,
        agentId: tabId,
        draftId,
      }),
    [draftId, serverId, tabId],
  );
  const draftInput = useAgentInputDraft({
    draftKey: draftStoreKey,
    initialCwd: workspaceDirectory ?? "",
    composer: {
      initialServerId: serverId,
      initialValues: workspaceDirectory ? { workingDir: workspaceDirectory } : undefined,
      isVisible: true,
      onlineServerIds: isConnected ? [serverId] : [],
      lockedWorkingDir: workspaceDirectory ?? undefined,
    },
  });
  const composerState = draftInput.composerState;
  if (!composerState) {
    throw new Error("Workspace draft composer state is required");
  }
  const clearDraftInput = draftInput.clear;
  const setDraftText = draftInput.setText;
  const setDraftAttachments = draftInput.setAttachments;
  const pendingAutoSubmit = useWorkspaceDraftSubmissionStore((state) => {
    const pending = state.pendingByDraftId[draftId] ?? null;
    return pending?.serverId === serverId && pending.workspaceId === workspaceId ? pending : null;
  });
  const consumePendingAutoSubmit = useWorkspaceDraftSubmissionStore(
    (state) => state.consumePending,
  );
  const autoSubmitConfig = pendingAutoSubmit
    ? {
        provider: pendingAutoSubmit.provider,
        modeId: pendingAutoSubmit.modeId ?? null,
        model: pendingAutoSubmit.model ?? null,
        thinkingOptionId: pendingAutoSubmit.thinkingOptionId ?? null,
        featureValues: pendingAutoSubmit.featureValues,
      }
    : null;
  const allowsEmptyAutoSubmit = pendingAutoSubmit?.allowEmptyText === true;

  const {
    formErrorMessage,
    isSubmitting,
    optimisticStreamItems,
    draftAgent,
    handleCreateFromInput,
  } = useDraftAgentCreateFlow<Agent, AgentSnapshotPayload>({
    draftId,
    getPendingServerId: () => serverId,
    allowEmptyText: allowsEmptyAutoSubmit,
    validateBeforeSubmit: ({ text }) => {
      if (!allowsEmptyAutoSubmit && !text.trim()) {
        return "Initial prompt is required";
      }
      if (composerState.providerDefinitions.length === 0) {
        return "No available providers on the selected host";
      }
      if (!(autoSubmitConfig?.provider ?? composerState.selectedProvider)) {
        return "Select a model";
      }
      if (composerState.isModelLoading) {
        return "Model defaults are still loading";
      }
      if (!(autoSubmitConfig?.model ?? composerState.effectiveModelId)) {
        return "No model is available for the selected provider";
      }
      if (!workspaceDirectory) {
        return "Workspace directory not found";
      }
      if (!client) {
        return "Host is not connected";
      }
      return null;
    },
    onBeforeSubmit: () => {
      void composerState.persistFormPreferences();
      if (isWeb) {
        (document.activeElement as HTMLElement | null)?.blur?.();
      }
      Keyboard.dismiss();
    },
    buildDraftAgent: (attempt) => {
      invariant(workspaceDirectory, "Workspace directory is required");
      const now = attempt.timestamp;
      const model = autoSubmitConfig?.model ?? (composerState.effectiveModelId || null);
      const thinkingOptionId =
        autoSubmitConfig?.thinkingOptionId ?? (composerState.effectiveThinkingOptionId || null);
      const modeId =
        autoSubmitConfig?.modeId ??
        (composerState.modeOptions.length > 0 && composerState.selectedMode !== ""
          ? composerState.selectedMode
          : null);
      const provider = autoSubmitConfig?.provider ?? composerState.selectedProvider;
      if (!provider) {
        throw new Error("Select a model");
      }
      return {
        serverId,
        id: tabId,
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
        runtimeInfo: { provider, sessionId: null, model, modeId },
        title: "Agent",
        cwd: workspaceDirectory,
        model,
        features: composerState.statusControls.features,
        thinkingOptionId,
        labels: {},
      };
    },
    createRequest: async ({ attempt, text, images, attachments }) => {
      invariant(workspaceDirectory, "Workspace directory is required");
      invariant(workspaceExecutionAuthority, "Workspace authority is required");
      if (!client) {
        throw new Error("Host is not connected");
      }

      const provider = autoSubmitConfig?.provider ?? composerState.selectedProvider;
      if (!provider) {
        throw new Error("Select a model");
      }
      const config = buildWorkspaceDraftAgentConfig({
        provider,
        cwd: workspaceDirectory,
        ...(autoSubmitConfig?.modeId
          ? { modeId: autoSubmitConfig.modeId }
          : composerState.modeOptions.length > 0 && composerState.selectedMode !== ""
            ? { modeId: composerState.selectedMode }
            : {}),
        model: autoSubmitConfig?.model ?? (composerState.effectiveModelId || undefined),
        thinkingOptionId:
          autoSubmitConfig?.thinkingOptionId ??
          (composerState.effectiveThinkingOptionId || undefined),
        featureValues: autoSubmitConfig?.featureValues ?? composerState.featureValues,
      });

      const imagesData = await encodeImages(images);
      const result = await client.createAgent({
        config,
        workspaceId: workspaceExecutionAuthority.workspaceId,
        ...(text ? { initialPrompt: text } : {}),
        clientMessageId: attempt.clientMessageId,
        ...(imagesData && imagesData.length > 0 ? { images: imagesData } : {}),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      });

      return {
        agentId: result.id,
        result,
      };
    },
    onCreateSuccess: ({ result }) => {
      clearDraftInput("sent");
      onCreated(result);
    },
  });

  const isReadyForPendingAutoSubmit = Boolean(
    pendingAutoSubmit &&
      draftInput.isHydrated &&
      workspaceDirectory &&
      client &&
      !isSubmitting &&
      !composerState.isModelLoading,
  );
  const autoSubmitKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isReadyForPendingAutoSubmit) {
      return;
    }
    const submitKey = `${serverId}:${workspaceId}:${draftId}`;
    if (autoSubmitKeyRef.current === submitKey) {
      return;
    }
    const submission = consumePendingAutoSubmit({ serverId, workspaceId, draftId });
    if (!submission) {
      return;
    }
    autoSubmitKeyRef.current = submitKey;
    setDraftText("");
    setDraftAttachments([]);
    void handleCreateFromInput({
      text: submission.text,
      attachments: submission.attachments,
      cwd: submission.cwd,
    }).catch(() => {
      setDraftText(submission.text);
      setDraftAttachments(submission.attachments);
      autoSubmitKeyRef.current = null;
    });
  }, [
    consumePendingAutoSubmit,
    draftId,
    handleCreateFromInput,
    isReadyForPendingAutoSubmit,
    serverId,
    setDraftAttachments,
    setDraftText,
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
    (provider: Parameters<typeof composerState.setProviderFromUser>[0]) => {
      composerState.setProviderFromUser(provider);
      focusInputRef.current?.();
    },
    [composerState],
  );

  const handleModeSelectWithFocus = useCallback(
    (modeId: string) => {
      composerState.setModeFromUser(modeId);
      focusInputRef.current?.();
    },
    [composerState],
  );

  const handleModelSelectWithFocus = useCallback(
    (modelId: string) => {
      composerState.setModelFromUser(modelId);
      focusInputRef.current?.();
    },
    [composerState],
  );

  const handleProviderAndModelSelectWithFocus = useCallback(
    (
      provider: Parameters<typeof composerState.setProviderAndModelFromUser>[0],
      modelId: string,
    ) => {
      composerState.setProviderAndModelFromUser(provider, modelId);
      focusInputRef.current?.();
    },
    [composerState],
  );

  const handleThinkingOptionSelectWithFocus = useCallback(
    (optionId: string) => {
      composerState.setThinkingOptionFromUser(optionId);
      focusInputRef.current?.();
    },
    [composerState],
  );

  const handleSetFeatureWithFocus = useCallback(
    (featureId: string, value: unknown) => {
      composerState.statusControls.onSetFeature?.(featureId, value);
      focusInputRef.current?.();
    },
    [composerState],
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

        <View style={[styles.inputAreaWrapper, { paddingBottom: insets.bottom }]}>
          <Composer
            agentId={tabId}
            serverId={serverId}
            isPaneFocused={isPaneFocused}
            onSubmitMessage={handleCreateFromInput}
            isSubmitLoading={isSubmitting}
            blurOnSubmit={true}
            value={draftInput.text}
            onChangeText={draftInput.setText}
            attachments={draftInput.attachments}
            onChangeAttachments={draftInput.setAttachments}
            cwd={draftInput.cwd}
            clearDraft={draftInput.clear}
            autoFocus={shouldAutoFocusWorkspaceDraftComposer({ isPaneFocused, isSubmitting })}
            onAddImages={handleAddImagesCallback}
            onFocusInput={handleFocusInputCallback}
            commandDraftConfig={composerState.commandDraftConfig}
            statusControls={{
              ...composerState.statusControls,
              onSelectProvider: handleProviderSelectWithFocus,
              onSelectMode: handleModeSelectWithFocus,
              onSelectModel: handleModelSelectWithFocus,
              onSelectProviderAndModel: handleProviderAndModelSelectWithFocus,
              onSelectThinkingOption: handleThinkingOptionSelectWithFocus,
              onSetFeature: handleSetFeatureWithFocus,
              onDropdownClose: () => focusInputRef.current?.(),
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
