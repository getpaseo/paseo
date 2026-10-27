import { i18n } from "@/i18n/i18next";
import { router } from "expo-router";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";
import type { PendingWorkspaceDraftSetup } from "@/stores/workspace-draft-submission-store";
import { remapDraftCwdToWorkspace } from "@/screens/new-workspace-fork-context";
import { captureCreationInput } from "./internal/capture";
import { useDraftStore } from "@/stores/draft-store";
import {
  buildDraftWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import {
  isWorkspaceAttachment,
  userAttachmentsOnly,
} from "@/attachments/workspace-attachment-utils";
import type { QueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { MessagePayload } from "@/composer/types";
import type { useAgentInputDraft } from "@/composer/draft/input-draft";
import {
  splitComposerAttachmentsForSubmit,
  resolveComposerAttachmentSubmitFormat,
} from "@/composer/attachments/submit";
import { ensureCheckoutStatus } from "@/git/checkout-status-cache";
import { getHostProjectId, type HostProjectListItem } from "@/projects/host-projects";
import { captureWorkspaceDraftCleanup } from "@/screens/new-workspace/background-handoff";
import { getAttachmentKey } from "@/composer/attachments/workspace-cleanup";
import {
  defaultBasePickerItem,
  pickerItemToCheckoutRequest,
  type PickerItem,
} from "@/screens/new-workspace-picker-item";
import { useSessionStore } from "@/stores/session-store";
import { transferComposerFollowUps } from "@/composer/submission/writer";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { buildDraftStoreKey, generateDraftId } from "@/stores/draft-keys";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import {
  buildWorkspaceTabPersistenceKey,
  type WorkspaceDraftTabSetup,
} from "@/workspace-tabs/model";
import type { CreationSnapshot } from "@getpaseo/protocol/messages";
import { encodeImages } from "@/utils/encode-images";
import type { CreationAttempt } from "./model";
import { workspaceCreations } from "./runtime";

type ComposerState = NonNullable<ReturnType<typeof useAgentInputDraft>["composerState"]>;
type DraftCleanupInput = Parameters<typeof captureWorkspaceDraftCleanup>[0];
interface SubmitWorkspaceChatInput extends DraftCleanupInput {
  serverId: string;
  key: string;
  returnDraftId?: string;
  project: HostProjectListItem | null;
  sourceDirectory: string | null;
  worktreeSlug: string;
  createsWorktree: boolean;
  selectedItem: PickerItem | null;
  payload: MessagePayload;
  forkSetup: PendingWorkspaceDraftSetup | null;
  composerState: ComposerState | null;
  supportsForgeSearch: boolean;
  client: DaemonClient;
  queryClient: QueryClient;
  persistPreferences: () => Promise<unknown>;
}

interface WorkspaceCreationFailure {
  error: string;
  selectedItem: PickerItem | null;
}

// The returned draft takes back its form selection and ordinary submit error together.
const workspaceFailures = new Map<string, WorkspaceCreationFailure>();

export function takeWorkspaceCreationFailure(draftKey: string): WorkspaceCreationFailure | null {
  const failure = workspaceFailures.get(draftKey) ?? null;
  workspaceFailures.delete(draftKey);
  return failure;
}

/**
 * The composer released the submitted context when it submitted; the draft that takes the
 * submission back owns it again. Context added to the draft since then stays as it is.
 */
function restoreSubmittedContext(draftId: string, payload: MessagePayload) {
  const scopeKey = buildDraftWorkspaceAttachmentScopeKey(draftId);
  const attachments = useWorkspaceAttachmentsStore.getState();
  const present = new Set((attachments.attachmentsByScope[scopeKey] ?? []).map(getAttachmentKey));
  for (const attachment of payload.attachments.filter(isWorkspaceAttachment)) {
    if (!present.has(getAttachmentKey(attachment)))
      attachments.addWorkspaceAttachment({ scopeKey, attachment });
  }
}

/**
 * The workspace exists without its agent, so the input continues as that workspace's agent draft,
 * failed exactly as a draft whose own agent creation failed, holding the submitted input, context
 * and setup.
 */
function continueAsFailedAgentDraft(input: {
  attempt: CreationAttempt;
  draftId: string;
  payload: MessagePayload;
  setup: WorkspaceDraftTabSetup;
  sourceDirectory: string;
  workspace: CreationSnapshot["workspace"];
  error: string;
}) {
  const { attempt, draftId } = input;
  const workspaceDirectory =
    input.workspace?.workspaceDirectory ??
    useSessionStore.getState().sessions[attempt.serverId]?.workspaces.get(attempt.workspaceId)
      ?.workspaceDirectory ??
    input.sourceDirectory;
  useDraftStore.getState().saveDraftInput({
    draftKey: buildDraftStoreKey({ serverId: attempt.serverId, agentId: "", draftId }),
    draft: {
      text: input.payload.text,
      attachments: userAttachmentsOnly(input.payload.attachments),
    },
  });
  restoreSubmittedContext(draftId, input.payload);
  const createFlow = useCreateFlowStore.getState();
  createFlow.setPending({
    draftId,
    serverId: attempt.serverId,
    workspaceId: attempt.workspaceId,
    agentId: null,
    clientMessageId: `${draftId}:initial-message`,
    text: attempt.text,
    timestamp: Date.now(),
  });
  createFlow.markLifecycle({ draftId, lifecycle: "abandoned", errorMessage: input.error });
  const layouts = useWorkspaceLayoutStore.getState();
  const workspaceKey = buildWorkspaceTabPersistenceKey({
    serverId: attempt.serverId,
    workspaceId: attempt.workspaceId,
  });
  if (!workspaceKey) return;
  // The submitted cwd is relative to the source checkout; the draft runs in the created workspace.
  const setup = {
    ...input.setup,
    cwd: remapDraftCwdToWorkspace({
      cwd: input.setup.cwd,
      sourceDirectory: input.sourceDirectory,
      workspaceDirectory,
    }),
  };
  const target = { kind: "draft", draftId, setup } as const;
  const agentTabs = layouts
    .getWorkspaceTabs(workspaceKey)
    .filter((tab) => tab.target.kind === "agent" && tab.target.agentId === attempt.agentId);
  const draftTabIds = agentTabs.length
    ? agentTabs.map((tab) => layouts.replaceTab(workspaceKey, tab.tabId, target))
    : [layouts.openTab({ workspaceKey, target, intent: "background" })];
  // The draft composer owns the follow-ups until its own agent creation hands them on.
  const draftTabId = draftTabIds.find((tabId) => tabId !== null);
  if (draftTabId) transferComposerFollowUps(attempt.serverId, attempt.agentId, draftTabId);
}

/** Captures one intent. All preparation continues under the app owner after navigation. */
export function submitWorkspaceChat(input: SubmitWorkspaceChatInput) {
  const { serverId, project, sourceDirectory, composerState } = input;
  if (!useSessionStore.getState().sessions[serverId]?.serverInfo?.features?.creationLifecycle) {
    throw new Error(i18n.t("newWorkspace.creation.updateHost"));
  }
  if (!project || !sourceDirectory)
    throw new Error(i18n.t("newWorkspace.creation.chooseProjectHost"));
  if (!composerState?.selectedProvider) throw new Error(i18n.t("newWorkspace.errors.selectModel"));
  const projectId = getHostProjectId(project, serverId);
  if (!projectId) throw new Error(i18n.t("newWorkspace.creation.projectUnavailable"));
  const payload = captureCreationInput(input.payload);
  const provider = composerState.selectedProvider;
  const cwd = input.forkSetup
    ? remapDraftCwdToWorkspace({
        cwd: input.forkSetup.setup.cwd,
        sourceDirectory,
        workspaceDirectory: sourceDirectory,
      })
    : payload.cwd;
  const config = captureCreationInput({
    provider,
    cwd,
    modeId: composerState.effectiveModeId || undefined,
    model: composerState.effectiveModelId || undefined,
    thinkingOptionId: composerState.effectiveThinkingOptionId || undefined,
    featureValues: composerState.featureValues,
  });
  const wire = splitComposerAttachmentsForSubmit(payload.attachments, {
    format: resolveComposerAttachmentSubmitFormat({
      supportsForgeAttachments: input.supportsForgeSearch,
    }),
  });
  const selectedItem = captureCreationInput(input.selectedItem);
  const clearConsumedDraft = captureWorkspaceDraftCleanup(input);
  const draftVersion = useDraftStore.getState().drafts[input.draftKey]?.version;
  const intent = JSON.stringify([
    input.key,
    draftVersion,
    projectId,
    sourceDirectory,
    input.createsWorktree,
    selectedItem,
    config,
    payload,
  ]);
  const submitted = workspaceCreations.submit({
    serverId,
    key: intent,
    provider,
    config: {
      modeId: config.modeId,
      model: config.model,
      thinkingOptionId: config.thinkingOptionId,
    },
    projectId,
    projectName: project.projectName,
    text: payload.text,
    onWorkspaceFailed: (attempt, error) => {
      workspaceFailures.set(input.draftKey, { error, selectedItem });
      if (input.returnDraftId) restoreSubmittedContext(input.returnDraftId, payload);
      // The New workspace composer owns the follow-ups until the form is submitted again.
      transferComposerFollowUps(serverId, attempt.agentId, input.draftKey);
      router.replace(
        buildNewWorkspaceRoute({
          serverId,
          sourceDirectory,
          projectId,
          draftId: input.returnDraftId,
        }) as never,
      );
    },
    onAgentFailed: (attempt, error, workspace) => {
      // Release the form first; the draft then takes the submitted input and its context.
      clearConsumedDraft();
      continueAsFailedAgentDraft({
        attempt,
        draftId: input.draftId?.trim() || generateDraftId(),
        payload,
        setup: {
          provider,
          cwd,
          modeId: config.modeId ?? null,
          model: config.model ?? null,
          thinkingOptionId: config.thinkingOptionId ?? null,
          featureValues: config.featureValues ?? {},
        },
        sourceDirectory,
        workspace,
        error,
      });
    },
    message: {
      kind: "user_message",
      text: payload.text,
      timestamp: new Date(),
      images: wire.images,
      attachments: wire.attachments,
    },
    prepare: async () => {
      await input.persistPreferences();
      const images = await encodeImages(wire.images);
      const status = input.createsWorktree
        ? await ensureCheckoutStatus({
            queryClient: input.queryClient,
            client: input.client,
            serverId,
            cwd: sourceDirectory,
          })
        : null;
      const checkout = status
        ? pickerItemToCheckoutRequest(selectedItem ?? defaultBasePickerItem(status))
        : undefined;
      return {
        source: input.createsWorktree
          ? {
              kind: "worktree",
              cwd: sourceDirectory,
              projectId,
              worktreeSlug: input.worktreeSlug,
              ...checkout,
            }
          : { kind: "directory", path: sourceDirectory, projectId },
        agent: { config, initialPrompt: payload.text, images, attachments: wire.attachments },
      };
    },
    onComplete: clearConsumedDraft,
  });
  // Follow-ups kept by a returned form continue behind this submission's initial prompt.
  transferComposerFollowUps(serverId, input.draftKey, submitted.agentId);
  return submitted;
}
