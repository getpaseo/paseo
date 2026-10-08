import type { UserComposerAttachment } from "@/attachments/types";
import type { DraftAgentControlsProps } from "@/composer/agent-controls";
import type { UseAgentFormStateResult } from "@/hooks/use-agent-form-state";
import type { AgentSettingsProfiles } from "@getpaseo/protocol/agent-settings-profile";

export interface DraftKeyContext {
  selectedServerId: string | null;
}

export type DraftKeyInput = string | ((context: DraftKeyContext) => string);

interface InitialSettingsProfileSelection {
  selectedServerId: string | null;
  initialServerId: string | null | undefined;
  settingsProfileId: string | undefined;
  profileChoice: string | undefined;
  bundle: AgentSettingsProfiles | undefined;
}

export function resolveDraftSettingsProfileId(
  input: InitialSettingsProfileSelection,
): string | undefined {
  const initialProfileId =
    input.selectedServerId === input.initialServerId ? input.settingsProfileId : undefined;
  const profileId = input.profileChoice ?? initialProfileId ?? input.bundle?.activeProfileId;
  if (input.bundle && !input.bundle.profiles.some((profile) => profile.id === profileId)) {
    return input.bundle.activeProfileId;
  }
  return profileId;
}

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
  settingsProfileId?: string;
  onSelectSettingsProfile?: (id: string) => void;
}): DraftAgentControlsProps {
  const { formState, features, onSetFeature, onApplyAgentProfile, onDropdownClose } = input;
  return {
    settingsProfileId: input.settingsProfileId,
    onSelectSettingsProfile: input.onSelectSettingsProfile,
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
