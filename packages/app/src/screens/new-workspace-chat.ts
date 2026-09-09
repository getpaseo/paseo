import { resolveModelSelectionReadiness } from "@/provider-selection/provider-selection";
import {
  validateDraftSubmission,
  shouldAllowEmptyDraftText,
} from "@/composer/draft/workspace-tab-core";
import type { AgentInputDraft } from "@/composer/draft/input-draft";
import type { ComposerAttachment } from "@/attachments/types";
import type { MessagePayload } from "@/composer/types";
import type { normalizeWorkspaceDescriptor } from "@/stores/session-store";
import type { PendingWorkspaceDraftSetup } from "@/stores/workspace-draft-submission-store";
import type { WorkspaceDraftTabSetup } from "@/workspace-tabs/model";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import {
  resolveComposerAttachmentSubmitFormat,
  splitComposerAttachmentsForSubmit,
} from "@/composer/attachments/submit";
import {
  getWorkspaceNamingAttachments,
  remapDraftCwdToWorkspace,
} from "./new-workspace-fork-context";

export interface SubmitDraftInput {
  serverId: string;
  clearDraft: (lifecycle: "sent" | "abandoned") => void;
  draftId?: string;
  initialSetup?: WorkspaceDraftTabSetup;
  workspaceId: string;
  workspaceDirectory: string;
  text: string;
  attachments: ComposerAttachment[];
  provider: AgentProvider;
  composerState: NewWorkspaceComposerState;
  supportsForgeSearch: boolean;
}

export type NewWorkspaceComposerState = Pick<
  NonNullable<AgentInputDraft["composerState"]>,
  | "selectedProvider"
  | "selectedMode"
  | "effectiveModelId"
  | "effectiveThinkingOptionId"
  | "featureValues"
  | "providerDefinitions"
  | "availableModels"
  | "allModelsHidden"
  | "isModelLoading"
>;

interface CreateChatAgentInput {
  payload: MessagePayload;
  submitWorkspaceDraft: (input: SubmitDraftInput) => void;
  composerState: NewWorkspaceComposerState | null;
  forkDraftSetup?: PendingWorkspaceDraftSetup | null;
  ensureWorkspace: (input: {
    cwd: string;
    prompt: string;
    attachments: AgentAttachment[];
    withInitialAgent: boolean;
  }) => Promise<Pick<ReturnType<typeof normalizeWorkspaceDescriptor>, "id" | "workspaceDirectory">>;
  serverId: string;
  clearDraft: (lifecycle: "sent" | "abandoned") => void;
  draftId?: string;
  supportsForgeSearch: boolean;
  labels: {
    composerStateRequired: string;
    selectModel: string;
  };
}

function buildWorkspaceDraftSetupFromComposer(input: {
  cwd: string;
  provider: AgentProvider;
  composerState: NewWorkspaceComposerState;
}): WorkspaceDraftTabSetup {
  return {
    provider: input.provider,
    cwd: input.cwd,
    modeId: input.composerState.selectedMode || null,
    model: input.composerState.effectiveModelId || null,
    thinkingOptionId: input.composerState.effectiveThinkingOptionId || null,
    featureValues: input.composerState.featureValues ?? {},
  };
}

function buildWorkspaceDraftSetupForCreatedWorkspace(input: {
  forkDraftSetup: PendingWorkspaceDraftSetup | null | undefined;
  workspaceDirectory: string;
  provider: AgentProvider;
  composerState: NewWorkspaceComposerState;
}): WorkspaceDraftTabSetup | undefined {
  if (!input.forkDraftSetup) {
    return undefined;
  }
  return buildWorkspaceDraftSetupFromComposer({
    cwd: remapDraftCwdToWorkspace({
      cwd: input.forkDraftSetup.setup.cwd,
      sourceDirectory: input.forkDraftSetup.sourceDirectory,
      workspaceDirectory: input.workspaceDirectory,
    }),
    provider: input.provider,
    composerState: input.composerState,
  });
}

export class ModelSelectionValidationError extends Error {}

export function getNewWorkspaceModelSelectionError(
  composerState: NewWorkspaceComposerState,
): string | null {
  const readiness = resolveModelSelectionReadiness({
    providerCount: composerState.providerDefinitions.length,
    selection: {
      provider: composerState.selectedProvider,
      modelId: composerState.effectiveModelId ?? "",
      availableModels: composerState.availableModels,
      isModelLoading: composerState.isModelLoading,
      allModelsHidden: composerState.allModelsHidden,
    },
    autoSubmitConfig: null,
  });
  return readiness.reason ?? null;
}

export function resolveNewWorkspaceSubmissionError(
  error: string | ModelSelectionValidationError | null,
  composerState: NewWorkspaceComposerState | null,
): string | null {
  if (!(error instanceof ModelSelectionValidationError)) return error;
  return composerState ? getNewWorkspaceModelSelectionError(composerState) : error.message;
}

export async function runCreateChatAgent(input: CreateChatAgentInput): Promise<void> {
  const { payload, composerState, ensureWorkspace, serverId, clearDraft } = input;
  const { text, attachments, cwd } = payload;
  if (!composerState) {
    throw new Error(input.labels.composerStateRequired);
  }
  const provider = composerState.selectedProvider;
  if (!provider) {
    throw new ModelSelectionValidationError(input.labels.selectModel);
  }
  const modelError = getNewWorkspaceModelSelectionError(composerState);
  if (modelError) throw new ModelSelectionValidationError(modelError);
  const submissionError = validateDraftSubmission({
    text,
    allowsEmptyAutoSubmit: shouldAllowEmptyDraftText({ allowsEmptyAutoSubmit: false, attachments }),
    composerState,
    autoSubmitConfig: null,
    workspaceDirectory: cwd,
    // ensureWorkspace owns the connection check; selection must pass before it runs.
    hasClient: true,
  });
  if (submissionError) {
    throw new Error(submissionError);
  }
  const attachmentSubmitFormat = resolveComposerAttachmentSubmitFormat({
    supportsForgeAttachments: input.supportsForgeSearch,
  });
  const { attachments: reviewAttachments } = splitComposerAttachmentsForSubmit(attachments, {
    format: attachmentSubmitFormat,
  });
  const workspaceNamingAttachments = getWorkspaceNamingAttachments(reviewAttachments);
  const ensuredWorkspace = await ensureWorkspace({
    cwd,
    prompt: text,
    attachments: workspaceNamingAttachments,
    withInitialAgent: true,
  });
  const initialSetup = buildWorkspaceDraftSetupForCreatedWorkspace({
    forkDraftSetup: input.forkDraftSetup,
    workspaceDirectory: ensuredWorkspace.workspaceDirectory,
    provider,
    composerState,
  });
  input.submitWorkspaceDraft({
    serverId,
    clearDraft,
    draftId: input.draftId,
    initialSetup,
    workspaceId: ensuredWorkspace.id,
    workspaceDirectory: ensuredWorkspace.workspaceDirectory,
    text,
    attachments,
    provider,
    composerState,
    supportsForgeSearch: input.supportsForgeSearch,
  });
}
