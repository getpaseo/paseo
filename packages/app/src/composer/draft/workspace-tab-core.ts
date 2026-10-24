import { resolveSubmissionReadiness } from "@/provider-selection/provider-selection";
import type { DraftSelectionSourceFlags } from "./input-draft-core";

export interface WorkspaceDraftAutoSubmitConfig {
  provider: string;
  model: string | null;
}

/**
 * Decides what the draft create request should submit for model/mode/thinking.
 *
 * Programmatic auto-submits always carry explicitly configured values and keep
 * the legacy behavior. Interactive composer submits omit values the user never
 * explicitly picked, so the provider's own configured default applies
 * (issue #623); the server is told via `selectionSource: "implicit"` that it
 * should not backfill a catalog default model either.
 */
export function resolveDraftSubmitSelection(input: {
  autoSubmitConfig: {
    modeId: string | null;
    model: string | null;
    thinkingOptionId: string | null;
  } | null;
  selectionSource?: DraftSelectionSourceFlags | null;
  effectiveModelId: string | null;
  effectiveModeId: string;
  effectiveThinkingOptionId: string | null;
}): {
  modeId?: string;
  model?: string;
  selectionSource?: "explicit" | "implicit";
  thinkingOptionId?: string;
} {
  if (input.autoSubmitConfig) {
    return resolveAutoSubmitSelection({
      autoSubmitConfig: input.autoSubmitConfig,
      effectiveModelId: input.effectiveModelId,
      effectiveModeId: input.effectiveModeId,
      effectiveThinkingOptionId: input.effectiveThinkingOptionId,
    });
  }
  return resolveInteractiveSubmitSelection(input);
}

function resolveAutoSubmitSelection(input: {
  autoSubmitConfig: {
    modeId: string | null;
    model: string | null;
    thinkingOptionId: string | null;
  };
  effectiveModelId: string | null;
  effectiveModeId: string;
  effectiveThinkingOptionId: string | null;
}): { modeId?: string; model?: string; thinkingOptionId?: string } {
  const modeId =
    input.autoSubmitConfig.modeId ?? (input.effectiveModeId !== "" ? input.effectiveModeId : null);
  const model = input.autoSubmitConfig.model ?? (input.effectiveModelId || null);
  const thinkingOptionId =
    input.autoSubmitConfig.thinkingOptionId ?? (input.effectiveThinkingOptionId || null);
  return {
    ...(modeId ? { modeId } : {}),
    ...(model ? { model } : {}),
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
  };
}

function resolveInteractiveSubmitSelection(input: {
  selectionSource?: DraftSelectionSourceFlags | null;
  effectiveModelId: string | null;
  effectiveModeId: string;
  effectiveThinkingOptionId: string | null;
}): { modeId?: string; model?: string; selectionSource?: "implicit"; thinkingOptionId?: string } {
  // Tolerate callers that predate the selectionSource plumbing: treat an
  // absent flag as implicit (omit the value, let the provider default apply).
  const modelIsExplicit = (input.selectionSource?.model ?? "implicit") === "explicit";
  const modeIsExplicit = (input.selectionSource?.modeId ?? "implicit") === "explicit";
  const thinkingIsExplicit = (input.selectionSource?.thinkingOptionId ?? "implicit") === "explicit";
  const model = modelIsExplicit ? input.effectiveModelId || null : null;
  const modeId = modeIsExplicit && input.effectiveModeId !== "" ? input.effectiveModeId : null;
  const thinkingOptionId =
    modelIsExplicit || thinkingIsExplicit ? input.effectiveThinkingOptionId || null : null;
  return {
    ...(modeId ? { modeId } : {}),
    ...(model ? { model } : {}),
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
    ...(modelIsExplicit ? {} : { selectionSource: "implicit" as const }),
  };
}

export function shouldAllowEmptyDraftText(input: {
  allowsEmptyAutoSubmit: boolean;
  attachments: readonly unknown[];
}): boolean {
  return input.allowsEmptyAutoSubmit || input.attachments.length > 0;
}

export function validateDraftSubmission(input: {
  text: string;
  allowsEmptyAutoSubmit: boolean;
  composerState: {
    providerDefinitions: unknown[];
    selectedProvider: string | null;
    isModelLoading: boolean;
    effectiveModelId: string | null;
    availableModels: unknown[];
  };
  autoSubmitConfig: WorkspaceDraftAutoSubmitConfig | null;
  workspaceDirectory: string | null;
  isConnected: boolean;
}): string | null {
  const {
    text,
    allowsEmptyAutoSubmit,
    composerState,
    autoSubmitConfig,
    workspaceDirectory,
    isConnected,
  } = input;
  const readiness = resolveSubmissionReadiness({
    text,
    allowsEmptyAutoSubmit,
    providerCount: composerState.providerDefinitions.length,
    selection: {
      provider: composerState.selectedProvider,
      modelId: composerState.effectiveModelId ?? "",
      availableModels: composerState.availableModels,
      isModelLoading: composerState.isModelLoading,
    },
    autoSubmitConfig,
    workspaceDirectory,
    isConnected,
  });
  return readiness.ok ? null : (readiness.reason ?? null);
}
