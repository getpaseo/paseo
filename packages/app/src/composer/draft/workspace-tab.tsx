import type { ComposerOptionControls } from "@/agent-controls/option-controls";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import { Keyboard, StyleSheet as RNStyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { useContainerWidthBelow } from "@/hooks/use-container-width";
import invariant from "tiny-invariant";
import { Composer } from "@/composer";
import { type ComposerEditingSession, useComposerFullscreen } from "@/composer/editing-session";
import { ComposerImportPill } from "@/composer/draft/import-pill";
import { COMPOSER_PILL_CLEARANCE } from "@/composer/pill-styles";
import { composerWorkspaceAttachment } from "@/composer/attachments/workspace";
import { useAgentInputDraft } from "@/composer/draft/input-draft";
import type { CreateAgentInitialValues } from "@/hooks/use-agent-form-state";
import { useDraftAgentCreateFlow, type DraftCreateAttempt } from "@/composer/draft/create-flow";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { buildWorkspaceDraftAgentConfig } from "@/screens/workspace/workspace-draft-agent-config";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import type { Agent } from "@/stores/session-store";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import { useWorkspaceDraftSubmissionStore } from "@/stores/workspace-draft-submission-store";
import { useAgentControlCommandCenterActions } from "@/command-center/agent-control-registration";
import { encodeImages } from "@/utils/encode-images";
import { shouldAutoFocusWorkspaceDraftComposer } from "@/screens/workspace/workspace-draft-pane-focus";
import {
  resolveDraftWorkingDirectory,
  shouldAllowEmptyDraftText,
  validateDraftSubmission,
} from "@/composer/draft/workspace-tab-core";
import { DRAFT_CAPABILITIES } from "@/composer/draft/timeline";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceComposerAttachment } from "@/attachments/types";
import {
  useDraftWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import type { UserMessageImageAttachment } from "@/types/stream";
import { COMPACT_CONTENT_WIDTH, useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import {
  buildWorkspaceTabPersistenceKey,
  type WorkspaceDraftTabSetup,
} from "@/workspace-tabs/model";
import { openWorkspaceChanges } from "@/workspace-tabs/open-supporting-view";
import { useSettings } from "@/hooks/use-settings";
import { draftCreationKey } from "@/composer/draft/creation-key";

interface AutoSubmitConfig {
  provider: string;
  modeId: string | null;
  model: string | null;
  thinkingOptionId: string | null;
  providerOptions: Record<string, unknown>;
}

function resolveAutoSubmitConfig(
  pending: {
    provider: string;
    modeId?: string | null;
    model?: string | null;
    thinkingOptionId?: string | null;
    providerOptions?: Record<string, unknown>;
  } | null,
): AutoSubmitConfig | null {
  if (!pending) return null;
  return {
    provider: pending.provider,
    modeId: pending.modeId ?? null,
    model: pending.model ?? null,
    thinkingOptionId: pending.thinkingOptionId ?? null,
    providerOptions: pending.providerOptions ?? {},
  };
}

function resolveDraftModeIdOverride(input: {
  autoSubmitConfig: AutoSubmitConfig | null;
  effectiveModeId: string;
}): { modeId: string } | Record<string, never> {
  const { autoSubmitConfig, effectiveModeId } = input;
  if (autoSubmitConfig?.modeId) {
    return { modeId: autoSubmitConfig.modeId };
  }
  if (effectiveModeId !== "") {
    return { modeId: effectiveModeId };
  }
  return {};
}

function resolveDraftModeId(input: {
  autoSubmitConfig: AutoSubmitConfig | null;
  effectiveModeId: string;
}): string | null {
  const { autoSubmitConfig, effectiveModeId } = input;
  if (autoSubmitConfig?.modeId !== undefined) {
    return autoSubmitConfig.modeId;
  }
  if (effectiveModeId !== "") {
    return effectiveModeId;
  }
  return null;
}

async function submitDraftCreateRequest(input: {
  draftId: string;
  attempt: { clientMessageId: string };
  text: string;
  images?: UserMessageImageAttachment[];
  attachments?: unknown;
  cwd: string;
  client: DaemonClient | null;
  workspaceDirectory: string | null;
  workspaceId: string | null;
  autoSubmitConfig: AutoSubmitConfig | null;
  composerState: {
    selectedProvider: string | null;
    effectiveModeId: string;
    effectiveModelId: string | null;
    effectiveThinkingOptionId: string | null;
    providerOptions: Record<string, unknown> | undefined;
    metadata: Record<string, JsonValue>;
  };
  hostDisconnectedMessage: string;
  selectModelMessage: string;
}): Promise<{ agentId: string | null; result: AgentSnapshotPayload }> {
  const {
    attempt,
    text,
    images,
    attachments,
    cwd,
    client,
    workspaceDirectory,
    workspaceId,
    autoSubmitConfig,
    composerState,
  } = input;

  invariant(workspaceDirectory, "Workspace directory is required");
  invariant(workspaceId, "Workspace id is required");
  if (!client) {
    throw new Error(input.hostDisconnectedMessage);
  }

  const provider = autoSubmitConfig?.provider ?? composerState.selectedProvider;
  if (!provider) {
    throw new Error(input.selectModelMessage);
  }
  const modeIdOverride = resolveDraftModeIdOverride({
    autoSubmitConfig,
    effectiveModeId: composerState.effectiveModeId,
  });
  const config = buildWorkspaceDraftAgentConfig({
    provider,
    cwd,
    ...modeIdOverride,
    model: autoSubmitConfig?.model ?? (composerState.effectiveModelId || undefined),
    thinkingOptionId:
      autoSubmitConfig?.thinkingOptionId ?? (composerState.effectiveThinkingOptionId || undefined),
    providerOptions: autoSubmitConfig?.providerOptions ?? composerState.providerOptions,
  });

  const attachmentsArray = Array.isArray(attachments) ? attachments : undefined;
  const imagesData = await encodeImages(images);
  const request = {
    config,
    workspaceId,
    initialPrompt: text,
    clientMessageId: attempt.clientMessageId,
    ...(Object.keys(composerState.metadata).length > 0 ? { metadata: composerState.metadata } : {}),
    ...(imagesData && imagesData.length > 0 ? { images: imagesData } : {}),
    ...(attachmentsArray && attachmentsArray.length > 0 ? { attachments: attachmentsArray } : {}),
  };
  const result = await client.createAgent({
    ...request,
    idempotencyKey: draftCreationKey(input.draftId, request),
  });

  return {
    agentId: result.id,
    result,
  };
}

function buildDraftAgentSnapshot(input: {
  attempt: { timestamp: Date };
  serverId: string;
  tabId: string;
  workspaceDirectory: string | null;
  autoSubmitConfig: AutoSubmitConfig | null;
  composerState: {
    effectiveModelId: string | null;
    effectiveThinkingOptionId: string | null;
    effectiveModeId: string;
    selectedProvider: string | null;
    agentControls: { optionControls?: ComposerOptionControls };
  };
  selectModelMessage: string;
}): Agent {
  const { attempt, serverId, tabId, workspaceDirectory, autoSubmitConfig, composerState } = input;
  invariant(workspaceDirectory, "Workspace directory is required");
  const now = attempt.timestamp;
  const model = autoSubmitConfig?.model ?? (composerState.effectiveModelId || null);
  const thinkingOptionId =
    autoSubmitConfig?.thinkingOptionId ?? (composerState.effectiveThinkingOptionId || null);
  const modeId = resolveDraftModeId({
    autoSubmitConfig,
    effectiveModeId: composerState.effectiveModeId,
  });
  const provider = autoSubmitConfig?.provider ?? composerState.selectedProvider;
  if (!provider) {
    throw new Error(input.selectModelMessage);
  }
  return {
    serverId,
    id: tabId,
    provider,
    status: "running",
    turn: { phase: "idle", cancellationRequestId: null },
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
    options: composerState.agentControls.optionControls?.options,
    controls: composerState.agentControls.optionControls?.controls,
    thinkingOptionId,
    parentAgentId: null,
    labels: {},
  };
}

function buildDraftInitialValues(input: {
  initialSetup: WorkspaceDraftTabSetup | null;
}): CreateAgentInitialValues | undefined {
  if (!input.initialSetup) return undefined;
  return {
    provider: input.initialSetup.provider,
    modeId: input.initialSetup.modeId,
    model: input.initialSetup.model,
    thinkingOptionId: input.initialSetup.thinkingOptionId,
  };
}

interface WorkspaceDraftComposerProps {
  serverId: string;
  workspaceId: string;
  tabId: string;
  draftId: string;
  initialSetup?: WorkspaceDraftTabSetup;
  isPaneFocused: boolean;
  editingSession: ComposerEditingSession;
  onCreated: (snapshot: AgentSnapshotPayload) => void;
  onOpenImportSheet?: () => void;
}

function resolveImportPillPress(
  onOpenImportSheet: (() => void) | undefined,
  isSubmitting: boolean,
): (() => void) | null {
  if (isSubmitting) {
    return null;
  }
  return onOpenImportSheet ?? null;
}

/**
 * Creates the agent from the draft's first prompt. The conversation panel shows that prompt in
 * the timeline from the create-flow store while the agent is created.
 */
export function WorkspaceDraftComposer({
  serverId,
  workspaceId,
  tabId,
  draftId,
  initialSetup = undefined,
  isPaneFocused,
  editingSession,
  onCreated,
  onOpenImportSheet,
}: WorkspaceDraftComposerProps) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const workspaceFields = useWorkspaceFields(serverId, workspaceId, (w) => ({
    workspaceDirectory: w.workspaceDirectory,
    id: w.id,
  }));
  const workspaceDirectory = workspaceFields?.workspaceDirectory || null;
  const draftSetup = initialSetup ?? null;
  const draftWorkingDirectory = resolveDraftWorkingDirectory({
    workspaceDirectory,
    initialSetup: draftSetup,
  });
  const draftInitialValues = buildDraftInitialValues({
    initialSetup: draftSetup,
  });
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
    composer: {
      initialServerId: serverId,
      initialValues: draftInitialValues,
      initialProviderOptions: draftSetup?.providerOptions,
      isVisible: true,
      lockedWorkingDir: draftWorkingDirectory ?? undefined,
    },
  });
  const composerState = draftInput.composerState;
  if (!composerState) {
    throw new Error("Workspace draft composer state is required");
  }

  const draftProvider = composerState.selectedProvider;
  const draftProviderDefinitions = composerState.providerDefinitions;
  const draftThinkingOptions = composerState.availableThinkingOptions;
  const draftSelectedThinkingId = composerState.selectedThinkingOptionId;
  const draftSetThinkingOption = composerState.setThinkingOptionFromUser;
  const draftModeOptions = composerState.modeOptions;
  const draftSelectedMode = composerState.selectedMode;
  const draftSetMode = composerState.setModeFromUser;
  const draftOptionControls = composerState.agentControls.optionControls;

  const clearDraftInput = draftInput.clear;
  const replaceDraftText = draftInput.replaceText;
  const setDraftAttachments = draftInput.setAttachments;
  const pendingAutoSubmit = useWorkspaceDraftSubmissionStore((state) => {
    const pending = state.pendingByDraftId[draftId] ?? null;
    return pending?.serverId === serverId && pending.workspaceId === workspaceId ? pending : null;
  });
  const pendingCreateAttempt = useCreateFlowStore((state) => {
    const pending = state.pendingByDraftId[draftId] ?? null;
    return pending?.serverId === serverId && pending.lifecycle === "active" ? pending : null;
  });
  const consumePendingAutoSubmit = useWorkspaceDraftSubmissionStore(
    (state) => state.consumePending,
  );
  const autoSubmitConfig = resolveAutoSubmitConfig(pendingAutoSubmit);
  const initialCreateAttempt = useMemo<DraftCreateAttempt | null>(() => {
    if (!pendingCreateAttempt) {
      return null;
    }
    return {
      clientMessageId: pendingCreateAttempt.clientMessageId,
      text: pendingCreateAttempt.text,
      timestamp: new Date(pendingCreateAttempt.timestamp),
      ...(pendingCreateAttempt.images && pendingCreateAttempt.images.length > 0
        ? { images: pendingCreateAttempt.images }
        : {}),
      ...(pendingCreateAttempt.attachments && pendingCreateAttempt.attachments.length > 0
        ? { attachments: pendingCreateAttempt.attachments }
        : {}),
    };
  }, [pendingCreateAttempt]);
  const allowsEmptyAutoSubmit = pendingAutoSubmit?.allowEmptyText === true;
  const isCompactFormFactor = useIsCompactFormFactor();
  const isComposerFullscreen = useComposerFullscreen(editingSession);
  const { onLayout: onInputAreaLayout, isBelow: isCompactComposerLayout } = useContainerWidthBelow(
    COMPACT_CONTENT_WIDTH,
    { initialIsBelow: isCompactFormFactor },
  );
  const workspaceAttachmentScopeKey = useWorkspaceAttachmentScopeKey({
    serverId,
    cwd: composerState.workingDir,
    workspaceId,
  });
  const draftAttachmentScopeKey = useDraftWorkspaceAttachmentScopeKey(draftId);
  const openInSidePane = useSettings((settings) => settings.openInSidePane);
  const attachmentScopeKeys = useMemo(
    () => [draftAttachmentScopeKey, workspaceAttachmentScopeKey].filter(Boolean),
    [draftAttachmentScopeKey, workspaceAttachmentScopeKey],
  );
  const clearWorkspaceAttachments = useWorkspaceAttachmentsStore(
    (state) => state.clearWorkspaceAttachments,
  );
  const handleOpenWorkspaceAttachment = useCallback(
    (attachment: WorkspaceComposerAttachment) => {
      if (attachment.kind !== "review") {
        return;
      }
      openWorkspaceChanges({
        isCompact: isCompactFormFactor,
        workspaceKey: buildWorkspaceTabPersistenceKey({ serverId, workspaceId: workspaceId ?? "" }),
        preferences: openInSidePane,
      });
    },
    [isCompactFormFactor, openInSidePane, serverId, workspaceId],
  );

  const { formErrorMessage, isSubmitting, handleCreateFromInput, continueCreateFromAttempt } =
    useDraftAgentCreateFlow<Agent, AgentSnapshotPayload>({
      draftId,
      getPendingServerId: () => serverId,
      initialAttempt: initialCreateAttempt,
      allowEmptyText: allowsEmptyAutoSubmit,
      validateBeforeSubmit: ({ text, attachments }) => {
        const allowsEmptyDraftText = shouldAllowEmptyDraftText({
          allowsEmptyAutoSubmit,
          attachments,
        });
        return validateDraftSubmission({
          text,
          allowsEmptyAutoSubmit: allowsEmptyDraftText,
          composerState,
          autoSubmitConfig,
          workspaceDirectory: draftWorkingDirectory,
          isConnected,
        });
      },
      onBeforeSubmit: async () => {
        await composerState.persistFormPreferences();
        if (isWeb) {
          (document.activeElement as HTMLElement | null)?.blur?.();
        }
        Keyboard.dismiss();
      },
      buildDraftAgent: (attempt) =>
        buildDraftAgentSnapshot({
          attempt,
          serverId,
          tabId,
          workspaceDirectory: draftWorkingDirectory,
          autoSubmitConfig,
          composerState,
          selectModelMessage: t("workspaceSetup.errors.selectModel"),
        }),
      createRequest: async ({ attempt, text, images, attachments, cwd }) => {
        if (pendingAutoSubmit?.agentCreation) {
          const result = await pendingAutoSubmit.agentCreation.result;
          return { agentId: result.id, result };
        }
        return submitDraftCreateRequest({
          draftId,
          attempt,
          text,
          images,
          attachments,
          cwd,
          client,
          workspaceDirectory: draftWorkingDirectory,
          workspaceId: workspaceFields?.id ?? null,
          autoSubmitConfig,
          composerState,
          hostDisconnectedMessage: t("workspace.terminal.hostDisconnected"),
          selectModelMessage: t("workspaceSetup.errors.selectModel"),
        });
      },
      onCreateSuccess: ({ result }) => {
        clearDraftInput("sent");
        clearWorkspaceAttachments({ scopeKey: draftAttachmentScopeKey });
        useWorkspaceDraftSubmissionStore.getState().clearDraftSetup({ draftId });
        onCreated(result);
      },
    });
  useAgentControlCommandCenterActions({
    sourceId: `draft:${serverId}:${tabId}`,
    enabled: isPaneFocused && !isSubmitting,
    controls: {
      serverId,
      ownerKey: tabId,
      provider: draftProvider,
      providerDefinitions: draftProviderDefinitions,
      models: {
        providers: composerState.modelSelectorProviders,
        selectedProvider: draftProvider,
        selectedModelId: composerState.effectiveModelId,
        select: (provider, modelId) => {
          composerState.setProviderAndModelFromUser(provider, modelId);
        },
      },
      thinking: {
        options: draftThinkingOptions,
        selectedId: draftSelectedThinkingId,
        select: draftSetThinkingOption,
      },
      modes: {
        options: draftModeOptions,
        selectedId: draftSelectedMode,
        select: draftSetMode,
      },
      optionControls: draftOptionControls ?? null,
    },
  });
  const isReadyForPendingAutoSubmit = Boolean(
    pendingAutoSubmit &&
    draftInput.isHydrated &&
    draftWorkingDirectory &&
    client &&
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
    replaceDraftText("");
    setDraftAttachments([]);
    const preparedAttempt =
      initialCreateAttempt?.clientMessageId === submission.clientMessageId
        ? initialCreateAttempt
        : null;
    const createPromise = preparedAttempt
      ? continueCreateFromAttempt({
          attempt: preparedAttempt,
          cwd: submission.cwd,
        })
      : handleCreateFromInput({
          text: submission.text,
          attachments: submission.attachments,
          cwd: submission.cwd,
        });
    void createPromise.catch(() => {
      replaceDraftText(submission.text);
      setDraftAttachments(composerWorkspaceAttachment.userAttachmentsOnly(submission.attachments));
      autoSubmitKeyRef.current = null;
    });
  }, [
    continueCreateFromAttempt,
    consumePendingAutoSubmit,
    draftId,
    handleCreateFromInput,
    initialCreateAttempt,
    isReadyForPendingAutoSubmit,
    serverId,
    setDraftAttachments,
    replaceDraftText,
    workspaceId,
  ]);

  const focusInputRef = useRef<(() => void) | null>(null);

  const handleFocusInputCallback = useCallback((focus: () => void) => {
    focusInputRef.current = focus;
  }, []);

  const handleDropdownCloseFocus = useCallback(() => {
    focusInputRef.current?.();
  }, []);
  const importPillPress = resolveImportPillPress(onOpenImportSheet, isSubmitting);
  const composerAgentControls = useMemo(
    () => ({
      ...composerState.agentControls,
      onDropdownClose: handleDropdownCloseFocus,
      disabled: isSubmitting,
    }),
    [composerState.agentControls, handleDropdownCloseFocus, isSubmitting],
  );
  return (
    <View style={animatedStaticStyles.inputAreaWrapper} onLayout={onInputAreaLayout}>
      {formErrorMessage ? (
        <View style={styles.formErrorRow}>
          <View style={styles.formError}>
            <Text style={styles.errorText}>{formErrorMessage}</Text>
          </View>
        </View>
      ) : null}
      {importPillPress && !isComposerFullscreen ? (
        <View style={styles.importPillRow}>
          <View style={styles.importPillContent}>
            <ComposerImportPill onPress={importPillPress} />
          </View>
        </View>
      ) : null}
      <Composer
        agentId={tabId}
        serverId={serverId}
        workspaceId={workspaceId}
        isPaneFocused={isPaneFocused}
        onSubmitMessage={handleCreateFromInput}
        isSubmitLoading={isSubmitting}
        blurOnSubmit={true}
        textSource={draftInput.textSource}
        onChangeText={draftInput.editText}
        textReplacement={draftInput.textReplacement}
        attachments={draftInput.attachments}
        attachmentScopeKeys={attachmentScopeKeys}
        onOpenWorkspaceAttachment={handleOpenWorkspaceAttachment}
        onChangeAttachments={draftInput.setAttachments}
        cwd={composerState.workingDir}
        clearDraft={draftInput.clear}
        editingSession={editingSession}
        autoFocus={shouldAutoFocusWorkspaceDraftComposer({ isPaneFocused, isSubmitting })}
        autoFocusKey={String(draftInput.attachmentFocusRequestId)}
        onFocusInput={handleFocusInputCallback}
        commandDraft={composerState.commandDraft}
        agentControls={composerAgentControls}
        isCompactLayout={isCompactComposerLayout}
      />
    </View>
  );
}

const animatedStaticStyles = RNStyleSheet.create({
  inputAreaWrapper: {
    width: "100%",
    flexShrink: 1,
    // Content-sized inline; fills the dock's fullscreen slot.
    flexGrow: 1,
  },
});

const styles = StyleSheet.create((theme) => ({
  formErrorRow: {
    width: "100%",
    paddingHorizontal: theme.spacing[4],
    alignItems: "center",
  },
  importPillRow: {
    width: "100%",
    paddingHorizontal: theme.spacing[4],
    paddingTop: {
      xs: COMPOSER_PILL_CLEARANCE.compact,
      md: COMPOSER_PILL_CLEARANCE.wide,
    },
    paddingBottom: {
      xs: COMPOSER_PILL_CLEARANCE.compact,
      md: COMPOSER_PILL_CLEARANCE.wide,
    },
    alignItems: "center",
  },
  importPillContent: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    flexDirection: "row",
  },
  formError: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    marginBottom: theme.spacing[2],
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
