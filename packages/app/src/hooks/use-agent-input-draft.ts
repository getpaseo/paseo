import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComposerAttachment } from "@/attachments/types";
import type { DraftAgentStatusBarProps } from "@/components/agent-status-bar";
import type { DraftCommandConfig } from "@/hooks/use-agent-commands-query";
import {
  useAgentFormState,
  type CreateAgentInitialValues,
  type UseAgentFormStateResult,
} from "@/hooks/use-agent-form-state";
import { useDraftAgentFeatures } from "@/hooks/use-draft-agent-features";
import { useDraftStore } from "@/stores/draft-store";
import type { AgentModelDefinition } from "@server/server/agent/agent-sdk-types";
import type { AgentProvider } from "@server/server/agent/agent-sdk-types";

type AttachmentUpdater =
  | ComposerAttachment[]
  | ((prev: ComposerAttachment[]) => ComposerAttachment[]);

type AgentInputDraftComposerOptions = {
  initialServerId: string | null;
  initialValues?: CreateAgentInitialValues;
  isVisible?: boolean;
  onlineServerIds?: string[];
  lockedWorkingDir?: string;
};

type DraftKeyContext = {
  selectedServerId: string | null;
};

type DraftKeyInput = string | ((context: DraftKeyContext) => string);

type UseAgentInputDraftInput = {
  draftKey: DraftKeyInput;
  initialCwd?: string;
  composer?: AgentInputDraftComposerOptions;
};

type DraftComposerState = UseAgentFormStateResult & {
  workingDir: string;
  effectiveModelId: string;
  effectiveThinkingOptionId: string;
  featureValues: Record<string, unknown> | undefined;
  statusControls: DraftAgentStatusBarProps;
  commandDraftConfig: DraftCommandConfig | undefined;
};

interface AgentInputDraft {
  text: string;
  setText: (text: string) => void;
  attachments: ComposerAttachment[];
  setAttachments: (updater: AttachmentUpdater) => void;
  cwd: string;
  setCwd: (cwd: string) => void;
  clear: (lifecycle: "sent" | "abandoned") => void;
  isHydrated: boolean;
  composerState: DraftComposerState | null;
}

function hasDraftContent(input: {
  text: string;
  attachments: ComposerAttachment[];
  cwd: string;
}): boolean {
  return (
    input.text.trim().length > 0 || input.attachments.length > 0 || input.cwd.trim().length > 0
  );
}

function areAttachmentsEqual(input: {
  left: ComposerAttachment[];
  right: ComposerAttachment[];
}): boolean {
  if (input.left.length !== input.right.length) {
    return false;
  }

  return input.left.every((attachment, index) => {
    const other = input.right[index];
    return JSON.stringify(attachment) === JSON.stringify(other);
  });
}

function resolveDraftKey(input: {
  draftKey: DraftKeyInput;
  selectedServerId: string | null;
}): string {
  if (typeof input.draftKey === "function") {
    return input.draftKey({ selectedServerId: input.selectedServerId });
  }
  return input.draftKey;
}

function resolveEffectiveComposerModelId(input: {
  selectedModel: string;
  availableModels: AgentModelDefinition[];
}): string {
  return input.selectedModel.trim();
}

function resolveEffectiveComposerThinkingOptionId(input: {
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

function buildDraftComposerCommandConfig(input: {
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

function buildDraftStatusControls(input: {
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

export function useAgentInputDraft(input: UseAgentInputDraftInput): AgentInputDraft {
  const composerOptions = input.composer ?? null;
  const formState = useAgentFormState({
    initialServerId: composerOptions?.initialServerId ?? null,
    initialValues: composerOptions?.initialValues,
    isVisible: composerOptions?.isVisible ?? false,
    isCreateFlow: true,
    onlineServerIds: composerOptions?.onlineServerIds ?? [],
  });
  const draftKey = useMemo(
    () =>
      resolveDraftKey({
        draftKey: input.draftKey,
        selectedServerId: formState.selectedServerId,
      }),
    [formState.selectedServerId, input.draftKey],
  );
  const [text, setText] = useState("");
  const [attachments, setAttachmentsState] = useState<ComposerAttachment[]>([]);
  const [cwd, setCwd] = useState(input.initialCwd ?? "");
  const [isHydrated, setIsHydrated] = useState(false);
  const draftGenerationRef = useRef(0);
  const hydratedGenerationRef = useRef(0);

  const setAttachments = useCallback((updater: AttachmentUpdater) => {
    setAttachmentsState((previousAttachments) => {
      if (typeof updater === "function") {
        return updater(previousAttachments);
      }
      return updater;
    });
  }, []);

  const clear = useCallback(
    (lifecycle: "sent" | "abandoned") => {
      const store = useDraftStore.getState();
      store.clearDraftInput({ draftKey, lifecycle });

      const generation = store.beginDraftGeneration(draftKey);
      draftGenerationRef.current = generation;
      hydratedGenerationRef.current = generation;

      setText("");
      setAttachmentsState([]);
      setCwd("");
      setIsHydrated(true);
    },
    [draftKey],
  );

  useEffect(() => {
    const store = useDraftStore.getState();
    const generation = store.beginDraftGeneration(draftKey);
    draftGenerationRef.current = generation;
    hydratedGenerationRef.current = 0;

    setText("");
    setAttachmentsState([]);
    setCwd(input.initialCwd ?? "");
    setIsHydrated(false);

    let cancelled = false;

    void (async () => {
      const draft = await store.hydrateDraftInput({
        draftKey,
        initialCwd: input.initialCwd,
      });
      if (cancelled) {
        return;
      }
      if (!useDraftStore.getState().isDraftGenerationCurrent({ draftKey, generation })) {
        return;
      }

      if (draft) {
        setText(draft.text);
        setAttachmentsState(draft.attachments);
        setCwd(draft.cwd);
      }

      hydratedGenerationRef.current = generation;
      setIsHydrated(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [draftKey, input.initialCwd]);

  useEffect(() => {
    const currentGeneration = draftGenerationRef.current;
    if (currentGeneration <= 0) {
      return;
    }

    const store = useDraftStore.getState();
    const isCurrentGeneration = store.isDraftGenerationCurrent({
      draftKey,
      generation: currentGeneration,
    });
    if (!isCurrentGeneration) {
      return;
    }
    if (hydratedGenerationRef.current !== currentGeneration) {
      return;
    }

    const existing = store.getDraftInput(draftKey);
    const isSameDraft =
      existing !== undefined &&
      existing.text === text &&
      existing.cwd === cwd &&
      areAttachmentsEqual({
        left: existing.attachments,
        right: attachments,
      });
    if (isSameDraft) {
      return;
    }

    if (!hasDraftContent({ text, attachments, cwd })) {
      if (existing) {
        store.clearDraftInput({ draftKey, lifecycle: "abandoned" });
      }
      return;
    }

    store.saveDraftInput({
      draftKey,
      draft: {
        text,
        attachments,
        cwd,
      },
    });
  }, [attachments, cwd, draftKey, text]);

  const lockedWorkingDir = composerOptions?.lockedWorkingDir?.trim() ?? "";
  useEffect(() => {
    if (!composerOptions || !lockedWorkingDir) {
      return;
    }
    if (formState.workingDir.trim() === lockedWorkingDir) {
      return;
    }
    formState.setWorkingDir(lockedWorkingDir);
  }, [composerOptions, formState, lockedWorkingDir]);

  const effectiveModelId = useMemo(
    () =>
      resolveEffectiveComposerModelId({
        selectedModel: formState.selectedModel,
        availableModels: formState.availableModels,
      }),
    [formState.availableModels, formState.selectedModel],
  );

  const effectiveThinkingOptionId = useMemo(
    () =>
      resolveEffectiveComposerThinkingOptionId({
        selectedThinkingOptionId: formState.selectedThinkingOptionId,
        availableModels: formState.availableModels,
        effectiveModelId,
      }),
    [effectiveModelId, formState.availableModels, formState.selectedThinkingOptionId],
  );

  const workingDir = lockedWorkingDir || formState.workingDir;
  const {
    features: draftFeatures,
    featureValues: draftFeatureValues,
    setFeatureValue: setDraftFeatureValue,
  } = useDraftAgentFeatures({
    serverId: formState.selectedServerId,
    provider: formState.selectedProvider,
    cwd: workingDir,
    modeId: formState.selectedMode,
    modelId: effectiveModelId,
    thinkingOptionId: effectiveThinkingOptionId,
  });

  const commandDraftConfig = useMemo(
    () =>
      composerOptions
        ? buildDraftComposerCommandConfig({
            provider: formState.selectedProvider,
            cwd: workingDir,
            modeOptions: formState.modeOptions,
            selectedMode: formState.selectedMode,
            effectiveModelId,
            effectiveThinkingOptionId,
            featureValues: draftFeatureValues,
          })
        : undefined,
    [
      composerOptions,
      effectiveModelId,
      effectiveThinkingOptionId,
      draftFeatureValues,
      workingDir,
      formState.modeOptions,
      formState.selectedMode,
      formState.selectedProvider,
    ],
  );

  const composerState = useMemo<DraftComposerState | null>(() => {
    if (!composerOptions) {
      return null;
    }

    return {
      ...formState,
      workingDir,
      effectiveModelId,
      effectiveThinkingOptionId,
      featureValues: draftFeatureValues,
      statusControls: buildDraftStatusControls({
        formState,
        features: draftFeatures,
        onSetFeature: setDraftFeatureValue,
      }),
      commandDraftConfig,
    };
  }, [
    commandDraftConfig,
    composerOptions,
    effectiveModelId,
    effectiveThinkingOptionId,
    draftFeatures,
    draftFeatureValues,
    formState,
    setDraftFeatureValue,
    workingDir,
  ]);

  return {
    text,
    setText,
    attachments,
    setAttachments,
    cwd,
    setCwd,
    clear,
    isHydrated,
    composerState,
  };
}

export const __private__ = {
  resolveDraftKey,
  resolveEffectiveComposerModelId,
  resolveEffectiveComposerThinkingOptionId,
  buildDraftComposerCommandConfig,
  buildDraftStatusControls,
};
