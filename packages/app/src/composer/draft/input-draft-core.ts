import type { UserComposerAttachment } from "@/attachments/types";
import type { DraftAgentControlsProps } from "@/composer/agent-controls";
import type { UseAgentFormStateResult } from "@/hooks/use-agent-form-state";

export interface DraftKeyContext {
  selectedServerId: string | null;
}

export type DraftKeyInput = string | ((context: DraftKeyContext) => string);

export function resolveDraftKey(input: {
  draftKey: DraftKeyInput;
  selectedServerId: string | null;
}): string {
  if (typeof input.draftKey === "function") {
    return input.draftKey({ selectedServerId: input.selectedServerId });
  }
  return input.draftKey;
}

export function buildDraftAgentControls(input: {
  formState: UseAgentFormStateResult;
  features?: DraftAgentControlsProps["features"];
  onSetFeature?: DraftAgentControlsProps["onSetFeature"];
  onApplyAgentProfile: DraftAgentControlsProps["onApplyAgentProfile"];
  onDropdownClose?: DraftAgentControlsProps["onDropdownClose"];
}): DraftAgentControlsProps {
  const { formState, features, onSetFeature, onApplyAgentProfile, onDropdownClose } = input;
  return {
    providerDefinitions: formState.providerDefinitions,
    selectedProvider: formState.selectedProvider,
    modeOptions: formState.modeOptions,
    selectedMode: formState.selectedMode,
    onSelectMode: formState.setModeFromUser,
    models: formState.availableModels,
    selectedModel: formState.selectedModel,
    onSelectModel: formState.setModelFromUser,
    isModelLoading: formState.isModelLoading,
    modelSelectorProviders: formState.modelSelectorProviders,
    isAllModelsLoading: formState.isAllModelsLoading,
    onSelectProviderAndModel: formState.setProviderAndModelFromUser,
    thinkingOptions: formState.availableThinkingOptions,
    selectedThinkingOptionId: formState.selectedThinkingOptionId,
    onSelectThinkingOption: formState.setThinkingOptionFromUser,
    onApplyAgentProfile,
    features,
    onSetFeature,
    onDropdownClose,
    onModelSelectorOpen: formState.refetchProviderModelsIfStale,
    onRetryModelProvider: formState.refreshProviderModels,
    isRetryingModelProvider: formState.isProviderModelsRefreshing,
    modelSelectorServerId: formState.selectedServerId,
  };
}

export function hasDraftContent(input: {
  text: string;
  attachments: UserComposerAttachment[];
}): boolean {
  return input.text.length > 0 || input.attachments.length > 0;
}

/**
 * Whether the composer's model/mode values were explicitly chosen by the user
 * (or seeded from an explicit source such as an existing agent's setup). An
 * "implicit" selection must be omitted from the create-agent request so the
 * provider's own configured default applies instead of a Paseo-resolved one.
 */
export type DraftSelectionSource = "explicit" | "implicit";

export interface DraftSelectionSourceFlags {
  model: DraftSelectionSource;
  modeId: DraftSelectionSource;
  thinkingOptionId: DraftSelectionSource;
}

export function resolveDraftSelectionSource(input: {
  userModified?: { model?: boolean; modeId?: boolean; thinkingOptionId?: boolean } | null;
  initialValues?: { model?: string | null; modeId?: string | null } | null;
}): DraftSelectionSourceFlags {
  const userModified = input.userModified ?? {};
  const initialValues = input.initialValues ?? {};
  return {
    model:
      (userModified.model ?? false) || Boolean(initialValues.model?.trim())
        ? "explicit"
        : "implicit",
    modeId:
      (userModified.modeId ?? false) || Boolean(initialValues.modeId?.trim())
        ? "explicit"
        : "implicit",
    thinkingOptionId: (userModified.thinkingOptionId ?? false) ? "explicit" : "implicit",
  };
}

export function areAttachmentsEqual(input: {
  left: UserComposerAttachment[];
  right: UserComposerAttachment[];
}): boolean {
  if (input.left.length !== input.right.length) {
    return false;
  }

  return input.left.every((attachment, index) => {
    const other = input.right[index];
    return JSON.stringify(attachment) === JSON.stringify(other);
  });
}
