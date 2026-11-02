import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";
import type {
  AgentMode,
  AgentModelDefinition,
  AgentProvider,
  ProviderSnapshotEntry,
} from "@getpaseo/protocol/agent-types";
import { buildProviderDefinitions } from "@/utils/provider-definitions";
import {
  buildSelectableProviderSelectorProviders,
  type ProviderSelectorProvider,
} from "@/provider-selection/provider-selection";
import { filterSelectableModels } from "@/provider-selection/model-catalog";
import { OptimisticFormPreferences } from "@/create-agent-preferences/optimistic-preferences";
import { applyAgentProfilePreferences } from "@/create-agent-preferences/preferences";
import { useProvidersSnapshot } from "./use-providers-snapshot";
import {
  useFormPreferences,
  mergeProviderPreferences,
  type FormPreferences,
} from "./use-form-preferences";
import {
  resolveAgentForm,
  resolveEffectiveModel,
  normalizeSelectedModelId,
  resolveDefaultModelId,
  mergeSelectedComposerPreferences,
  buildProviderDefinitionMap,
  buildProviderDefinitionMapForStatuses,
  RESOLVABLE_PROVIDER_STATUSES,
  SELECTABLE_PROVIDER_STATUSES,
  type FormInitialValues,
  type FormState,
  type ProviderModelsByProvider,
} from "@/provider-selection/resolve-agent-form";
import { openAgentForm, type AgentFormCatalog } from "@/provider-selection/agent-form-store";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { MaterializedAgentProfile } from "@/agent-profiles";

export type { FormInitialValues } from "@/provider-selection/resolve-agent-form";

export interface UseAgentFormStateOptions {
  serverId: string | null;
  workingDir: string;
  initialValues?: FormInitialValues;
  isVisible?: boolean;
  isCreateFlow?: boolean;
}

export interface UseAgentFormStateResult {
  selectedServerId: string | null;
  selectedProvider: AgentProvider | null;
  /** The provider as it is now, which a render may not have reached yet. */
  getSelectedProvider: () => AgentProvider | null;
  selectedMode: string;
  setModeFromUser: (modeId: string) => void;
  selectedModel: string;
  /** `false` when the provider's loaded catalog does not list the model. */
  setModelFromUser: (modelId: string) => boolean;
  selectedThinkingOptionId: string;
  setThinkingOptionFromUser: (thinkingOptionId: string) => void;
  workingDir: string;
  providerDefinitions: AgentProviderDefinition[];
  providerDefinitionMap: Map<AgentProvider, AgentProviderDefinition>;
  agentDefinition?: AgentProviderDefinition;
  allProviderEntries?: ProviderSnapshotEntry[];
  modeOptions: AgentMode[];
  availableModels: AgentModelDefinition[];
  allProviderModels: Map<string, AgentModelDefinition[]>;
  modelSelectorProviders: ProviderSelectorProvider[];
  isAllModelsLoading: boolean;
  isProviderModelsRefreshing: boolean;
  availableThinkingOptions: NonNullable<AgentModelDefinition["thinkingOptions"]>;
  isModelLoading: boolean;
  modelError: string | null;
  refreshProviderModels: (provider?: AgentProvider) => void;
  refetchProviderModelsIfStale: () => void;
  /** `false` when the provider is unknown or not ready. */
  setProviderAndModelFromUser: (provider: AgentProvider, modelId: string) => boolean;
  applyProfileFromUser: (profile: MaterializedAgentProfile) => void;
  clearProviderSelectionFromUser: () => void;
  workingDirIsEmpty: boolean;
  persistFormPreferences: () => Promise<void>;
}

const EMPTY_CATALOG: AgentFormCatalog = {
  selectableProviders: new Map(),
  models: new Map(),
  providerPreferences: () => undefined,
};

function resolveSelectedProviderModes(input: {
  selectedEntry: ProviderSnapshotEntry | null;
  provider: AgentProvider | null;
  providerDefinitionMap: Map<AgentProvider, AgentProviderDefinition>;
}): AgentMode[] {
  const { selectedEntry, provider, providerDefinitionMap } = input;
  if (selectedEntry?.modes) {
    return selectedEntry.modes;
  }
  if (provider) {
    return providerDefinitionMap.get(provider)?.modes ?? [];
  }
  return [];
}

function buildAllProviderModels(
  snapshotEntries: ProviderSnapshotEntry[] | undefined,
): Map<string, AgentModelDefinition[]> {
  const map = new Map<string, AgentModelDefinition[]>();
  for (const entry of snapshotEntries ?? []) {
    map.set(entry.provider, filterSelectableModels(entry.models ?? []) ?? []);
  }
  return map;
}

function buildProviderModelsByProvider(
  snapshotEntries: ProviderSnapshotEntry[] | undefined,
): ProviderModelsByProvider {
  const map: ProviderModelsByProvider = new Map();
  for (const entry of snapshotEntries ?? []) {
    map.set(
      entry.provider,
      entry.status === "ready" ? filterSelectableModels(entry.models ?? null) : null,
    );
  }
  return map;
}

async function persistProviderPreferences(input: {
  provider: AgentProvider;
  formState: FormState;
  availableModels: AgentModelDefinition[] | null;
  updatePreferences: (
    updates: Partial<FormPreferences> | ((current: FormPreferences) => FormPreferences),
  ) => Promise<FormPreferences>;
}): Promise<void> {
  const { provider, formState, availableModels, updatePreferences } = input;
  const resolvedModel = resolveEffectiveModel(availableModels, formState.model);
  const modelId = resolvedModel?.id ?? formState.model;
  await updatePreferences((current) =>
    mergeProviderPreferences({
      preferences: current,
      provider,
      updates: {
        model: modelId || undefined,
        mode: formState.modeId || undefined,
        ...(modelId && formState.thinkingOptionId
          ? { thinkingByModel: { [modelId]: formState.thinkingOptionId } }
          : {}),
      },
    }),
  );
}

export function useAgentFormState(options: UseAgentFormStateOptions): UseAgentFormStateResult {
  const { serverId, initialValues, workingDir, isVisible = true, isCreateFlow = true } = options;

  const { preferences, isLoading: isPreferencesLoading, updatePreferences } = useFormPreferences();
  const preferenceOverlayRef = useRef(new OptimisticFormPreferences(preferences));

  useEffect(() => {
    preferenceOverlayRef.current.reconcile(preferences);
  }, [preferences]);

  const updateCurrentPreferences = useCallback(
    async (
      updates: Partial<FormPreferences> | ((current: FormPreferences) => FormPreferences),
    ): Promise<FormPreferences> => {
      const pendingId = preferenceOverlayRef.current.begin(updates);
      try {
        const persisted = await updatePreferences(updates);
        preferenceOverlayRef.current.commit(pendingId, persisted);
        return persisted;
      } catch (error) {
        preferenceOverlayRef.current.reject(pendingId);
        throw error;
      }
    },
    [updatePreferences],
  );

  // The store reads what the host offers when a command runs; each render publishes the latest.
  const catalogRef = useRef<AgentFormCatalog>(EMPTY_CATALOG);
  const [formStore] = useState(() => openAgentForm(() => catalogRef.current));
  const { form: formState, resolution } = useSyncExternalStore(
    formStore.subscribe,
    formStore.getState,
    formStore.getState,
  );
  const dispatch = formStore.dispatch;

  const {
    entries: snapshotEntries,
    isLoading: snapshotIsLoading,
    isRefreshing: snapshotIsRefreshing,
    error: snapshotError,
    refresh: refreshSnapshot,
    refetchIfStale: refetchSnapshotIfStale,
  } = useProvidersSnapshot(serverId, { cwd: workingDir });

  const isConnected = useHostRuntimeIsConnected(serverId ?? "");

  const allProviderEntries = useMemo(() => snapshotEntries ?? [], [snapshotEntries]);
  const snapshotProviderDefinitions = useMemo(
    () => buildProviderDefinitions(snapshotEntries),
    [snapshotEntries],
  );
  const snapshotProviderDefinitionMap = useMemo(
    () => buildProviderDefinitionMap(snapshotProviderDefinitions),
    [snapshotProviderDefinitions],
  );
  const snapshotResolvableProviderDefinitionMap = useMemo(
    () =>
      buildProviderDefinitionMapForStatuses({
        snapshotEntries,
        providerDefinitions: snapshotProviderDefinitions,
        statuses: RESOLVABLE_PROVIDER_STATUSES,
      }),
    [snapshotEntries, snapshotProviderDefinitions],
  );
  const snapshotSelectableProviderDefinitionMap = useMemo(() => {
    return buildProviderDefinitionMapForStatuses({
      snapshotEntries,
      providerDefinitions: snapshotProviderDefinitions,
      statuses: SELECTABLE_PROVIDER_STATUSES,
    });
  }, [snapshotEntries, snapshotProviderDefinitions]);
  const snapshotAllProviderModels = useMemo(
    () => buildAllProviderModels(snapshotEntries),
    [snapshotEntries],
  );
  const snapshotProviderModelsByProvider = useMemo(
    () => buildProviderModelsByProvider(snapshotEntries),
    [snapshotEntries],
  );
  const snapshotModelSelectorProviders = useMemo(
    () => buildSelectableProviderSelectorProviders(snapshotEntries, isConnected),
    [snapshotEntries, isConnected],
  );
  const snapshotSelectedEntry = useMemo(
    () =>
      formState.provider
        ? ((snapshotEntries ?? []).find((entry) => entry.provider === formState.provider) ?? null)
        : null,
    [formState.provider, snapshotEntries],
  );
  const snapshotSelectedProviderModels = filterSelectableModels(
    snapshotSelectedEntry?.models ?? null,
  );
  const selectedProviderIsLoading = snapshotSelectedEntry?.status === "loading";
  const snapshotSelectedProviderModes = resolveSelectedProviderModes({
    selectedEntry: snapshotSelectedEntry,
    provider: formState.provider,
    providerDefinitionMap: snapshotProviderDefinitionMap,
  });
  const providerDefinitions = snapshotProviderDefinitions;
  const providerDefinitionMap = snapshotProviderDefinitionMap;
  const selectableProviderDefinitionMap = snapshotSelectableProviderDefinitionMap;
  const allProviderModels = snapshotAllProviderModels;
  catalogRef.current = {
    selectableProviders: selectableProviderDefinitionMap,
    models: allProviderModels,
    providerPreferences: (provider) =>
      preferenceOverlayRef.current.current().providerPreferences?.[provider],
  };
  const modelSelectorProviders = snapshotModelSelectorProviders;
  const availableModels = snapshotSelectedProviderModels;
  const modeOptions = snapshotSelectedProviderModes;
  const isModelSelectionLoading =
    isConnected &&
    (resolution.status === "pending" || snapshotIsLoading || selectedProviderIsLoading);
  const isAllModelsLoading = isModelSelectionLoading;

  useEffect(() => {
    dispatch({
      type: "INPUTS_CHANGED",
      serverId,
      isVisible,
      isCreateFlow,
      isPreferencesLoading,
      hasSnapshot: snapshotEntries !== undefined,
      initialValues,
      preferences,
      providerModelsByProvider: snapshotProviderModelsByProvider,
      allowedProviderMap: snapshotResolvableProviderDefinitionMap,
    });
  }, [
    serverId,
    isVisible,
    isCreateFlow,
    isPreferencesLoading,
    snapshotEntries,
    initialValues,
    preferences,
    snapshotProviderModelsByProvider,
    snapshotResolvableProviderDefinitionMap,
    dispatch,
  ]);

  const setProviderAndModelFromUser = useCallback(
    (provider: AgentProvider, modelId: string): boolean => {
      if (!formStore.setProviderAndModel(provider, modelId)) return false;
      const providerModels = allProviderModels.get(provider) ?? null;
      const nextModelId =
        normalizeSelectedModelId(modelId) || resolveDefaultModelId(providerModels);
      void updateCurrentPreferences((current) =>
        mergeSelectedComposerPreferences({
          preferences: current,
          provider,
          updates: {
            model: nextModelId || undefined,
          },
        }),
      );
      return true;
    },
    [allProviderModels, formStore, updateCurrentPreferences],
  );

  const clearProviderSelectionFromUser = useCallback(() => {
    dispatch({ type: "CLEAR_PROVIDER_SELECTION_FROM_USER" });
  }, [dispatch]);

  const applyProfileFromUser = useCallback(
    (profile: MaterializedAgentProfile) => {
      const provider = profile.provider as AgentProvider;
      if (!selectableProviderDefinitionMap.has(provider)) {
        return;
      }

      const formBefore = formStore.getState();
      const previousProvider = formBefore.form.provider;
      const providerDef = selectableProviderDefinitionMap.get(provider);
      const providerModels = allProviderModels.get(provider) ?? null;
      const providerPrefs = preferenceOverlayRef.current.current().providerPreferences?.[provider];
      const action = {
        type: "APPLY_PROFILE_FROM_USER" as const,
        provider,
        modelId: profile.modelId,
        modeId: profile.modeId,
        thinkingOptionId: profile.thinkingOptionId,
        providerDef,
        providerModels,
        providerPrefs,
      };
      const nextState = resolveAgentForm(formBefore, action);
      const previousProviderModeIds = previousProvider
        ? (providerDefinitionMap.get(previousProvider)?.modes.map((mode) => mode.id) ?? [])
        : [];

      dispatch(action);
      void updateCurrentPreferences((current) => {
        const { model, modeId, thinkingOptionId } = nextState.form;
        return applyAgentProfilePreferences({
          preferences: current,
          previousProvider,
          previousProviderModeIds,
          provider,
          modelId: model,
          modeId,
          thinkingOptionId,
          options: profile.options,
        });
      }).catch((error) => {
        console.warn("[useAgentFormState] persist profile preference failed", error);
      });
    },
    [
      allProviderModels,
      dispatch,
      formStore,
      providerDefinitionMap,
      selectableProviderDefinitionMap,
      updateCurrentPreferences,
    ],
  );

  const setModeFromUser = useCallback(
    (modeId: string) => {
      dispatch({ type: "SET_MODE_FROM_USER", modeId });
      const { provider } = formStore.getState().form;
      if (provider) {
        void updateCurrentPreferences((current) =>
          mergeSelectedComposerPreferences({
            preferences: current,
            provider,
            updates: {
              mode: modeId || undefined,
            },
          }),
        );
      }
    },
    [dispatch, formStore, updateCurrentPreferences],
  );

  const setModelFromUser = useCallback(
    (modelId: string): boolean => {
      if (!formStore.setModel(modelId)) return false;
      const { provider } = formStore.getState().form;
      if (provider) {
        const listed = allProviderModels.get(provider);
        const nextModelId =
          normalizeSelectedModelId(modelId) ||
          resolveDefaultModelId(listed?.length ? listed : null);
        void updateCurrentPreferences((current) =>
          mergeSelectedComposerPreferences({
            preferences: current,
            provider,
            updates: {
              model: nextModelId || undefined,
            },
          }),
        );
      }
      return true;
    },
    [allProviderModels, formStore, updateCurrentPreferences],
  );

  const setThinkingOptionFromUser = useCallback(
    (thinkingOptionId: string) => {
      dispatch({ type: "SET_THINKING_OPTION_FROM_USER", thinkingOptionId });
      const { provider, model: modelId } = formStore.getState().form;
      if (provider && modelId) {
        void updateCurrentPreferences((current) =>
          mergeSelectedComposerPreferences({
            preferences: current,
            provider,
            updates: {
              thinkingByModel: {
                [modelId]: thinkingOptionId,
              },
            },
          }),
        );
      }
    },
    [dispatch, formStore, updateCurrentPreferences],
  );

  const getSelectedProvider = useCallback(() => formStore.getState().form.provider, [formStore]);

  const refreshProviderModels = useCallback(
    (provider?: AgentProvider) => {
      void refreshSnapshot(provider ? [provider] : undefined);
    },
    [refreshSnapshot],
  );

  const refetchProviderModelsIfStale = useCallback(() => {
    refetchSnapshotIfStale(formState.provider);
  }, [formState.provider, refetchSnapshotIfStale]);

  const persistFormPreferences = useCallback(async () => {
    if (!formState.provider) {
      return;
    }
    await persistProviderPreferences({
      provider: formState.provider,
      formState,
      availableModels,
      updatePreferences: updateCurrentPreferences,
    });
  }, [availableModels, formState, updateCurrentPreferences]);

  const agentDefinition = formState.provider
    ? providerDefinitionMap.get(formState.provider)
    : undefined;
  const effectiveModel = resolveEffectiveModel(availableModels, formState.model);
  const availableThinkingOptionsRaw = effectiveModel?.thinkingOptions;
  const availableThinkingOptions = useMemo(
    () => availableThinkingOptionsRaw ?? [],
    [availableThinkingOptionsRaw],
  );
  const isModelLoading = isModelSelectionLoading;
  const modelError = snapshotError;

  const workingDirIsEmpty = !workingDir.trim();

  return useMemo(
    () => ({
      selectedServerId: serverId,
      selectedProvider: formState.provider,
      getSelectedProvider,
      selectedMode: formState.modeId,
      setModeFromUser,
      selectedModel: formState.model,
      setModelFromUser,
      selectedThinkingOptionId: formState.thinkingOptionId,
      setThinkingOptionFromUser,
      workingDir,
      providerDefinitions,
      providerDefinitionMap,
      agentDefinition,
      allProviderEntries,
      modeOptions,
      availableModels: availableModels ?? [],
      allProviderModels,
      modelSelectorProviders,
      isAllModelsLoading,
      isProviderModelsRefreshing: snapshotIsRefreshing,
      availableThinkingOptions,
      isModelLoading,
      modelError,
      refreshProviderModels,
      refetchProviderModelsIfStale,
      setProviderAndModelFromUser,
      applyProfileFromUser,
      clearProviderSelectionFromUser,
      workingDirIsEmpty,
      persistFormPreferences,
    }),
    [
      serverId,
      getSelectedProvider,
      formState.provider,
      formState.modeId,
      formState.model,
      formState.thinkingOptionId,
      workingDir,
      setModeFromUser,
      setModelFromUser,
      setThinkingOptionFromUser,
      providerDefinitions,
      providerDefinitionMap,
      agentDefinition,
      allProviderEntries,
      modeOptions,
      availableModels,
      allProviderModels,
      modelSelectorProviders,
      isAllModelsLoading,
      snapshotIsRefreshing,
      availableThinkingOptions,
      isModelLoading,
      modelError,
      refreshProviderModels,
      refetchProviderModelsIfStale,
      setProviderAndModelFromUser,
      applyProfileFromUser,
      clearProviderSelectionFromUser,
      workingDirIsEmpty,
      persistFormPreferences,
    ],
  );
}

export type CreateAgentInitialValues = FormInitialValues;
