import type { UserComposerAttachment } from "@/attachments/types";
import type { DraftAgentStatusBarProps } from "@/components/agent-status-bar";
import type { DraftCommandConfig } from "@/hooks/use-agent-commands-query";
import type { UseAgentFormStateResult } from "@/hooks/use-agent-form-state";
import type { AgentModelDefinition, AgentProvider } from "@server/server/agent/agent-sdk-types";

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

export function resolveEffectiveComposerModelId(input: {
  selectedModel: string;
  availableModels: AgentModelDefinition[];
}): string {
  return input.selectedModel.trim();
}

export function resolveEffectiveComposerThinkingOptionId(input: {
  selectedThinkingOptionId: string;
  availableModels: AgentModelDefinition[];
  effectiveModelId: string;
}): string {
  const selectedThinkingOptionId = input.selectedThinkingOptionId.trim();
  if (selectedThinkingOptionId) {
    return selectedThinkingOptionId;
  }

  const selectedModelDefinition =
    input.availableModels.find((model) => model.id === input.effectiveModelId) ?? null;
  return selectedModelDefinition?.defaultThinkingOptionId ?? "";
}

export function buildDraftComposerCommandConfig(input: {
  provider: AgentProvider | null;
  cwd: string;
  modeOptions: DraftAgentStatusBarProps["modeOptions"];
  selectedMode: string;
  effectiveModelId: string;
  effectiveThinkingOptionId: string;
  featureValues?: Record<string, unknown>;
}): DraftCommandConfig | undefined {
  const cwd = input.cwd.trim();
  if (!input.provider || !cwd) {
    return undefined;
  }

  return {
    provider: input.provider,
    cwd,
    ...(input.modeOptions.length > 0 && input.selectedMode !== ""
      ? { modeId: input.selectedMode }
      : {}),
    ...(input.effectiveModelId ? { model: input.effectiveModelId } : {}),
    ...(input.effectiveThinkingOptionId
      ? { thinkingOptionId: input.effectiveThinkingOptionId }
      : {}),
    ...(input.featureValues ? { featureValues: input.featureValues } : {}),
  };
}

export function buildDraftStatusControls(input: {
  formState: UseAgentFormStateResult;
  features?: DraftAgentStatusBarProps["features"];
  onSetFeature?: DraftAgentStatusBarProps["onSetFeature"];
  onDropdownClose?: DraftAgentStatusBarProps["onDropdownClose"];
}): DraftAgentStatusBarProps {
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
    allProviderModels: formState.allProviderModels,
    isAllModelsLoading: formState.isAllModelsLoading,
    onSelectProviderAndModel: formState.setProviderAndModelFromUser,
    thinkingOptions: formState.availableThinkingOptions,
    selectedThinkingOptionId: formState.selectedThinkingOptionId,
    onSelectThinkingOption: formState.setThinkingOptionFromUser,
    features,
    onSetFeature,
    onDropdownClose,
    onModelSelectorOpen: formState.refetchProviderModelsIfStale,
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
