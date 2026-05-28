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
  onDropdownClose?: DraftAgentControlsProps["onDropdownClose"];
}): DraftAgentControlsProps {
  const { formState, features, onSetFeature, onDropdownClose } = input;
  return {
    providerDefinitions: formState.providerDefinitions,
    selectedProvider: formState.selectedProvider,
    onSelectProvider: formState.setProviderFromUser,
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
    features,
    onSetFeature,
    onDropdownClose,
    onModelSelectorOpen: formState.refetchProviderModelsIfStale,
    modelSelectorServerId: formState.selectedServerId,
  };
}

export function hasDraftContent(input: {
  text: string;
  attachments: UserComposerAttachment[];
}): boolean {
  return input.text.trim().length > 0 || input.attachments.length > 0;
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
