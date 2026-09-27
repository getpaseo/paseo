import { resolveModelSelectionReadiness } from "@/provider-selection/provider-selection";
import {
  validateDraftSubmission,
  shouldAllowEmptyDraftText,
} from "@/composer/draft/workspace-tab-core";
import type { AgentInputDraft } from "@/composer/draft/input-draft";
import type { MessagePayload } from "@/composer/types";

export type NewWorkspaceComposerState = Pick<
  NonNullable<AgentInputDraft["composerState"]>,
  | "selectedProvider"
  | "effectiveModelId"
  | "providerDefinitions"
  | "availableModels"
  | "allModelsHidden"
  | "isModelLoading"
>;

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

/** Rejects a chat submission before workspace creation starts, so a rejection creates nothing. */
export function assertNewWorkspaceChatSubmission(input: {
  payload: MessagePayload;
  composerState: NewWorkspaceComposerState;
}): void {
  const { payload, composerState } = input;
  const modelError = getNewWorkspaceModelSelectionError(composerState);
  if (modelError) throw new ModelSelectionValidationError(modelError);
  const submissionError = validateDraftSubmission({
    text: payload.text,
    allowsEmptyAutoSubmit: shouldAllowEmptyDraftText({
      allowsEmptyAutoSubmit: false,
      attachments: payload.attachments,
    }),
    composerState,
    autoSubmitConfig: null,
    workspaceDirectory: payload.cwd,
    // ensureWorkspace owns the connection check; selection must pass before it runs.
    hasClient: true,
  });
  if (submissionError) {
    throw new Error(submissionError);
  }
}
