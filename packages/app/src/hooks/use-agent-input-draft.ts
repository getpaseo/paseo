import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AttachmentMetadata, ComposerAttachment } from "@/attachments/types";
import { useDraftStore } from "@/stores/draft-store";
import { useAgentFormState, type FormInitialValues } from "./use-agent-form-state";
import type { DraftAgentStatusBarProps } from "@/components/agent-status-bar";

type ImageUpdater = AttachmentMetadata[] | ((prev: AttachmentMetadata[]) => AttachmentMetadata[]);

interface AgentInputDraft {
  text: string;
  setText: (text: string) => void;
  images: AttachmentMetadata[];
  setImages: (updater: ImageUpdater) => void;
  clear: (lifecycle: "sent" | "abandoned") => void;
  isHydrated: boolean;
}

function hasDraftContent(input: { text: string; images: AttachmentMetadata[] }): boolean {
  return input.text.trim().length > 0 || input.images.length > 0;
}

function areImagesEqual(input: {
  left: AttachmentMetadata[];
  right: AttachmentMetadata[];
}): boolean {
  if (input.left.length !== input.right.length) {
    return false;
  }

  return input.left.every((image, index) => {
    const other = input.right[index];
    return (
      image.id === other?.id &&
      image.mimeType === other?.mimeType &&
      image.storageType === other?.storageType &&
      image.storageKey === other?.storageKey
    );
  });
}

export interface ComposerStateExposed {
  selectedProvider: string;
  selectedMode: string;
  modeOptions: import("@server/server/agent/agent-sdk-types").AgentMode[];
  selectedModel: string;
  effectiveModelId: string;
  effectiveThinkingOptionId: string;
  featureValues: Record<string, unknown>;
  statusControls: DraftAgentStatusBarProps;
  commandDraftConfig: {
    provider: string;
    cwd: string;
    modeId: string;
    model: string;
    thinkingOptionId: string;
    featureValues: Record<string, unknown>;
  };
}

interface ComposerConfig {
  initialServerId?: string | null;
  initialValues?: FormInitialValues;
  isVisible?: boolean;
  onlineServerIds?: string[];
  lockedWorkingDir?: string;
}

// Overload: accepts either a string draftKey (legacy) or an object with extra
// composer config (used by new-workspace-screen, workspace-setup-dialog).
export function useAgentInputDraft(
  input:
    | string
    | {
        draftKey: string;
        initialCwd?: string;
        composer?: ComposerConfig;
      },
): AgentInputDraft & {
  attachments: ComposerAttachment[];
  setAttachments: (
    updater: ComposerAttachment[] | ((prev: ComposerAttachment[]) => ComposerAttachment[]),
  ) => void;
  cwd: string;
  setCwd: (cwd: string) => void;
  composerState: ComposerStateExposed | null;
} {
  const draftKey = typeof input === "string" ? input : input.draftKey;
  const passedInitialCwd = typeof input === "object" ? (input.initialCwd ?? "") : "";
  const [cwdState, setCwdState] = useState<string>(passedInitialCwd);
  const initialCwd = cwdState;
  // Reset the cwd state whenever the caller-provided initialCwd changes
  // (e.g. switching workspaces). Wrapped in an effect to avoid setState in
  // render.
  useEffect(() => {
    setCwdState(passedInitialCwd);
  }, [passedInitialCwd]);
  const composerConfig = typeof input === "object" ? input.composer : undefined;
  const [text, setText] = useState("");
  const [images, setImagesState] = useState<AttachmentMetadata[]>([]);
  const [isHydrated, setIsHydrated] = useState(false);
  const draftGenerationRef = useRef(0);
  const hydratedGenerationRef = useRef(0);

  const setImages = useCallback((updater: ImageUpdater) => {
    setImagesState((previousImages) => {
      if (typeof updater === "function") {
        return updater(previousImages);
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
      setImagesState([]);
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
    setImagesState([]);
    setIsHydrated(false);

    let cancelled = false;

    void (async () => {
      const draft = await store.hydrateDraftInput(draftKey);
      if (cancelled) {
        return;
      }
      if (!useDraftStore.getState().isDraftGenerationCurrent({ draftKey, generation })) {
        return;
      }

      if (draft) {
        setText(draft.text);
        setImagesState(draft.images);
      }

      hydratedGenerationRef.current = generation;
      setIsHydrated(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [draftKey]);

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
      existing?.text === text &&
      areImagesEqual({
        left: existing?.images ?? [],
        right: images,
      });
    if (isSameDraft) {
      return;
    }

    if (!hasDraftContent({ text, images })) {
      if (existing) {
        store.clearDraftInput({ draftKey, lifecycle: "abandoned" });
      }
      return;
    }

    store.saveDraftInput({
      draftKey,
      draft: {
        text,
        images,
      },
    });
  }, [draftKey, images, text]);

  // Build composer state from useAgentFormState (provider/model/mode picker).
  const formState = useAgentFormState({
    initialServerId: composerConfig?.initialServerId ?? null,
    initialValues: composerConfig?.initialValues,
    isVisible: composerConfig?.isVisible ?? true,
    onlineServerIds: composerConfig?.onlineServerIds ?? [],
  });

  const composerState = useMemo<ComposerStateExposed | null>(() => {
    if (!composerConfig) return null;
    const statusControls: DraftAgentStatusBarProps = {
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
    };
    return {
      selectedProvider: formState.selectedProvider,
      selectedMode: formState.selectedMode,
      modeOptions: formState.modeOptions,
      selectedModel: formState.selectedModel,
      effectiveModelId: formState.selectedModel,
      effectiveThinkingOptionId: formState.selectedThinkingOptionId,
      featureValues: {},
      statusControls,
      commandDraftConfig: {
        provider: formState.selectedProvider,
        cwd: initialCwd,
        modeId: formState.selectedMode,
        model: formState.selectedModel,
        thinkingOptionId: formState.selectedThinkingOptionId,
        featureValues: {},
      },
    };
  }, [composerConfig, formState, initialCwd]);

  // Adapt the legacy images-only state to the ComposerAttachment[] shape used
  // by the composer + paseo-style screens. The fork's draft-store still
  // persists images only — github_search_item attachments are dropped on
  // save and are filtered out on load until the persistence layer follows.
  const attachments = useMemo<ComposerAttachment[]>(
    () => images.map((metadata) => ({ kind: "image", metadata })),
    [images],
  );

  const setAttachments = useCallback(
    (updater: ComposerAttachment[] | ((prev: ComposerAttachment[]) => ComposerAttachment[])) => {
      setImagesState((previousImages) => {
        const previousAttachments: ComposerAttachment[] = previousImages.map((metadata) => ({
          kind: "image",
          metadata,
        }));
        const nextAttachments =
          typeof updater === "function" ? updater(previousAttachments) : updater;
        const nextImages: AttachmentMetadata[] = [];
        for (const attachment of nextAttachments) {
          if (attachment.kind === "image") {
            nextImages.push(attachment.metadata);
          }
        }
        return nextImages;
      });
    },
    [],
  );

  return {
    text,
    setText,
    images,
    setImages,
    clear,
    isHydrated,
    // Aliases for the new composer API used by hubcode upstream screens.
    attachments,
    setAttachments,
    cwd: initialCwd,
    setCwd: setCwdState,
    composerState,
  };
}

// ---------------------------------------------------------------------------
// Test surface (kept under __private__ so unit tests can exercise pure helpers
// without us re-exporting them publicly).
// ---------------------------------------------------------------------------

type DraftKeyResolverInput = { selectedServerId: string | null };

function resolveDraftKey(input: {
  draftKey: string | ((input: DraftKeyResolverInput) => string);
  selectedServerId: string | null;
}): string {
  if (typeof input.draftKey === "function") {
    return input.draftKey({ selectedServerId: input.selectedServerId });
  }
  return input.draftKey;
}

interface AgentModelDefinitionLite {
  provider: string;
  id: string;
  defaultThinkingOptionId?: string;
}

function resolveEffectiveComposerModelId(input: {
  selectedModel: string;
  availableModels: AgentModelDefinitionLite[];
}): string {
  return input.selectedModel.trim();
}

function resolveEffectiveComposerThinkingOptionId(input: {
  selectedThinkingOptionId: string;
  availableModels: AgentModelDefinitionLite[];
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

interface DraftComposerCommandConfig {
  provider: string;
  cwd: string;
  modeId?: string;
  model?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
}

function buildDraftComposerCommandConfig(input: {
  provider: string | null;
  cwd: string;
  modeOptions: ReadonlyArray<{ id: string; label: string }>;
  selectedMode: string;
  effectiveModelId: string;
  effectiveThinkingOptionId: string;
  featureValues?: Record<string, unknown>;
}): DraftComposerCommandConfig | undefined {
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

export const __private__ = {
  hasDraftContent,
  areImagesEqual,
  resolveDraftKey,
  resolveEffectiveComposerModelId,
  resolveEffectiveComposerThinkingOptionId,
  buildDraftComposerCommandConfig,
};
