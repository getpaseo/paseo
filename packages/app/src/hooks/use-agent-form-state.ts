import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AGENT_PROVIDER_DEFINITIONS,
  type AgentProviderDefinition,
} from "@server/server/agent/provider-manifest";
import type {
  AgentMode,
  AgentModelDefinition,
  AgentProvider,
  ProviderSnapshotEntry,
} from "@server/server/agent/agent-sdk-types";
import { useHosts } from "@/runtime/host-runtime";
import { useProvidersSnapshot } from "./use-providers-snapshot";
import {
  useFormPreferences,
  mergeProviderPreferences,
  type FormPreferences,
  type ProviderPreferences,
} from "./use-form-preferences";

// Explicit overrides from URL params or "New Agent" button
export interface FormInitialValues {
  serverId?: string | null;
  provider?: AgentProvider;
  modeId?: string | null;
  model?: string | null;
  thinkingOptionId?: string | null;
  workingDir?: string;
}

// Tracks which fields the user has explicitly modified in this session
interface UserModifiedFields {
  serverId: boolean;
  provider: boolean;
  modeId: boolean;
  model: boolean;
  thinkingOptionId: boolean;
  workingDir: boolean;
}

const INITIAL_USER_MODIFIED: UserModifiedFields = {
  serverId: false,
  provider: false,
  modeId: false,
  model: false,
  thinkingOptionId: false,
  workingDir: false,
};

// Internal form state
interface FormState {
  serverId: string | null;
  provider: AgentProvider;
  modeId: string;
  model: string;
  thinkingOptionId: string;
  workingDir: string;
}

type UseAgentFormStateOptions = {
  initialServerId?: string | null;
  initialValues?: FormInitialValues;
  isVisible?: boolean;
  isCreateFlow?: boolean;
  isTargetDaemonReady?: boolean;
  onlineServerIds?: string[];
};

type UseAgentFormStateResult = {
  selectedServerId: string | null;
  setSelectedServerId: (value: string | null) => void;
  setSelectedServerIdFromUser: (value: string | null) => void;
  selectedProvider: AgentProvider;
  setProviderFromUser: (provider: AgentProvider) => void;
  selectedMode: string;
  setModeFromUser: (modeId: string) => void;
  selectedModel: string;
  setModelFromUser: (modelId: string) => void;
  selectedThinkingOptionId: string;
  setThinkingOptionFromUser: (thinkingOptionId: string) => void;
  workingDir: string;
  setWorkingDir: (value: string) => void;
  setWorkingDirFromUser: (value: string) => void;
  providerDefinitions: AgentProviderDefinition[];
  providerDefinitionMap: Map<AgentProvider, AgentProviderDefinition>;
  agentDefinition?: AgentProviderDefinition;
  allProviderEntries?: ProviderSnapshotEntry[];
  modeOptions: AgentMode[];
  availableModels: AgentModelDefinition[];
  allProviderModels: Map<string, AgentModelDefinition[]>;
  isAllModelsLoading: boolean;
  availableThinkingOptions: NonNullable<AgentModelDefinition["thinkingOptions"]>;
  isModelLoading: boolean;
  modelError: string | null;
  refreshProviderModels: () => void;
  invalidateProviderModels: () => void;
  setProviderAndModelFromUser: (provider: AgentProvider, modelId: string) => void;
  workingDirIsEmpty: boolean;
  persistFormPreferences: () => Promise<void>;
};

const allProviderDefinitions = AGENT_PROVIDER_DEFINITIONS;
const allProviderDefinitionMap = new Map<AgentProvider, AgentProviderDefinition>(
  allProviderDefinitions.map((definition) => [definition.id, definition]),
);
const fallbackDefinition = allProviderDefinitions[0];
const DEFAULT_PROVIDER: AgentProvider = fallbackDefinition?.id ?? "claude";
const DEFAULT_MODE_FOR_DEFAULT_PROVIDER = fallbackDefinition?.defaultModeId ?? "";

function normalizeSelectedModelId(modelId: string | null | undefined): string {
  const normalized = typeof modelId === "string" ? modelId.trim() : "";
  if (!normalized) {
    return "";
  }
  return normalized;
}

function resolveDefaultModel(
  availableModels: AgentModelDefinition[] | null,
): AgentModelDefinition | null {
  if (!availableModels || availableModels.length === 0) {
    return null;
  }
  return availableModels.find((model) => model.isDefault) ?? availableModels[0] ?? null;
}

function resolveDefaultModelId(availableModels: AgentModelDefinition[] | null): string {
  return resolveDefaultModel(availableModels)?.id ?? "";
}

function resolveEffectiveModel(
  availableModels: AgentModelDefinition[] | null,
  modelId: string,
): AgentModelDefinition | null {
  if (!availableModels || availableModels.length === 0) {
    return null;
  }
  const normalizedModelId = modelId.trim();
  if (!normalizedModelId) {
    return resolveDefaultModel(availableModels);
  }
  return (
    availableModels.find((model) => model.id === normalizedModelId) ??
    resolveDefaultModel(availableModels)
  );
}

function resolveThinkingOptionId(args: {
  availableModels: AgentModelDefinition[] | null;
  modelId: string;
  requestedThinkingOptionId: string;
}): string {
  const effectiveModel = resolveEffectiveModel(args.availableModels, args.modelId);
  const thinkingOptions = effectiveModel?.thinkingOptions ?? [];
  if (thinkingOptions.length === 0) {
    return "";
  }

  const normalizedThinkingOptionId = args.requestedThinkingOptionId.trim();
  if (
    normalizedThinkingOptionId &&
    thinkingOptions.some((option) => option.id === normalizedThinkingOptionId)
  ) {
    return normalizedThinkingOptionId;
  }

  return effectiveModel?.defaultThinkingOptionId ?? thinkingOptions[0]?.id ?? "";
}

/**
 * Pure function that resolves form state from multiple data sources.
 * Priority: explicit (URL params) > provider defaults > lightweight app prefs > fallback
 *
 * Only resolves fields that haven't been user-modified.
 */
function resolveFormState(
  initialValues: FormInitialValues | undefined,
  preferences: FormPreferences | null,
  availableModels: AgentModelDefinition[] | null,
  userModified: UserModifiedFields,
  currentState: FormState,
  validServerIds: Set<string>,
  allowedProviderMap: Map<AgentProvider, AgentProviderDefinition> = allProviderDefinitionMap,
): FormState {
  // Start with current state - we only update non-user-modified fields
  const result = { ...currentState };
  const fallbackProvider = allowedProviderMap.keys().next().value as AgentProvider | undefined;

  // 1. Resolve provider first (other fields depend on it)
  if (!userModified.provider) {
    if (initialValues?.provider && allowedProviderMap.has(initialValues.provider)) {
      result.provider = initialValues.provider;
    } else if (
      preferences?.provider &&
      allowedProviderMap.has(preferences.provider as AgentProvider)
    ) {
      result.provider = preferences.provider as AgentProvider;
    } else if (!allowedProviderMap.has(result.provider) && fallbackProvider) {
      result.provider = fallbackProvider;
    }
    // else keep current (initialized to DEFAULT_PROVIDER)
  } else if (!allowedProviderMap.has(result.provider) && fallbackProvider) {
    result.provider = fallbackProvider;
  }

  const providerDef = allowedProviderMap.get(result.provider);
  const providerPrefs = preferences?.providerPreferences?.[result.provider];

  // 2. Resolve modeId (depends on provider)
  if (!userModified.modeId) {
    const validModeIds = providerDef?.modes.map((m) => m.id) ?? [];

    if (
      typeof initialValues?.modeId === "string" &&
      initialValues.modeId.length > 0 &&
      validModeIds.includes(initialValues.modeId)
    ) {
      result.modeId = initialValues.modeId;
    } else if (providerPrefs?.mode && validModeIds.includes(providerPrefs.mode)) {
      result.modeId = providerPrefs.mode;
    } else {
      result.modeId = providerDef?.defaultModeId ?? validModeIds[0] ?? "";
    }
  }

  // 3. Resolve model (depends on provider + availableModels)
  if (!userModified.model) {
    const isValidModel = (m: string) => availableModels?.some((am) => am.id === m) ?? false;
    const initialModel = normalizeSelectedModelId(initialValues?.model);
    const preferredModel = normalizeSelectedModelId(providerPrefs?.model);
    const defaultModelId = resolveDefaultModelId(availableModels);

    if (initialModel) {
      if (!availableModels || isValidModel(initialModel)) {
        result.model = initialModel;
      } else {
        result.model = defaultModelId;
      }
    } else if (preferredModel) {
      if (!availableModels || isValidModel(preferredModel)) {
        result.model = preferredModel;
      } else {
        result.model = defaultModelId;
      }
    } else if (defaultModelId) {
      result.model = defaultModelId;
    } else {
      result.model = "";
    }
  }

  // 4. Resolve thinking option (depends on effective model)
  const initialThinkingOptionId =
    typeof initialValues?.thinkingOptionId === "string"
      ? initialValues.thinkingOptionId.trim()
      : "";

  if (!userModified.thinkingOptionId) {
    const effectiveModelId = result.model.trim();
    const preferredThinking = effectiveModelId
      ? (providerPrefs?.thinkingByModel?.[effectiveModelId]?.trim() ?? "")
      : "";

    if (initialThinkingOptionId.length > 0) {
      result.thinkingOptionId = initialThinkingOptionId;
    } else if (preferredThinking.length > 0) {
      result.thinkingOptionId = preferredThinking;
    } else {
      result.thinkingOptionId = "";
    }
  }

  // Validate thinking option once model metadata is available.
  if (availableModels) {
    result.thinkingOptionId = resolveThinkingOptionId({
      availableModels,
      modelId: result.model,
      requestedThinkingOptionId: result.thinkingOptionId,
    });
  }

  // 5. Resolve serverId (independent)
  if (!userModified.serverId) {
    if (initialValues?.serverId !== undefined) {
      result.serverId = initialValues.serverId;
    }
    // else keep current
  }

  // 6. Resolve workingDir (independent)
  if (!userModified.workingDir) {
    if (initialValues?.workingDir !== undefined) {
      result.workingDir = initialValues.workingDir;
    }
    // else keep current (empty string)
  }

  return result;
}

function combineInitialValues(
  initialValues: FormInitialValues | undefined,
  initialServerId: string | null,
): FormInitialValues | undefined {
  const hasExplicitServerId = initialValues?.serverId !== undefined;
  const serverIdFromOptions = initialServerId === null ? undefined : initialServerId;

  // If nobody provided initial values or an explicit serverId, let preferences drive defaults.
  if (!initialValues && !hasExplicitServerId && serverIdFromOptions === undefined) {
    return undefined;
  }

  if (hasExplicitServerId) {
    return { ...initialValues, serverId: initialValues?.serverId };
  }

  if (serverIdFromOptions !== undefined) {
    return { ...initialValues, serverId: serverIdFromOptions };
  }

  return initialValues;
}

export function useAgentFormState(options: UseAgentFormStateOptions = {}): UseAgentFormStateResult {
  const {
    initialServerId = null,
    initialValues,
    isVisible = true,
    isCreateFlow = true,
    isTargetDaemonReady = true,
    onlineServerIds = [],
  } = options;

  const { preferences, isLoading: isPreferencesLoading, updatePreferences } = useFormPreferences();

  const daemons = useHosts();

  // Build a set of valid server IDs for preference validation
  const validServerIds = useMemo(() => new Set(daemons.map((d) => d.serverId)), [daemons]);

  // Track which fields the user has explicitly modified
  const [userModified, setUserModified] = useState<UserModifiedFields>(INITIAL_USER_MODIFIED);

  // Form state
  const [formState, setFormState] = useState<FormState>(() => ({
    serverId: initialServerId,
    provider: DEFAULT_PROVIDER,
    modeId: DEFAULT_MODE_FOR_DEFAULT_PROVIDER,
    model: "",
    thinkingOptionId: "",
    workingDir: "",
  }));
  const formStateRef = useRef(formState);
  useEffect(() => {
    formStateRef.current = formState;
  }, [formState]);

  // Track if we've done initial resolution (to avoid flickering)
  const hasResolvedRef = useRef(false);

  // Reset user modifications when form becomes invisible
  useEffect(() => {
    if (!isVisible) {
      setUserModified(INITIAL_USER_MODIFIED);
      hasResolvedRef.current = false;
    }
  }, [isVisible]);

  const {
    entries: snapshotEntries,
    isLoading: snapshotIsLoading,
    isFetching: snapshotIsFetching,
    error: snapshotError,
    refresh: refreshSnapshot,
    invalidate: invalidateSnapshot,
  } = useProvidersSnapshot(formState.serverId);

  const allProviderEntries = useMemo(() => snapshotEntries ?? [], [snapshotEntries]);
  const snapshotProviderDefinitions = useMemo(() => {
    const snapshotProviders = new Set((snapshotEntries ?? []).map((entry) => entry.provider));
    return allProviderDefinitions.filter((definition) => snapshotProviders.has(definition.id));
  }, [snapshotEntries]);
  const snapshotProviderDefinitionMap = useMemo(
    () =>
      new Map<AgentProvider, AgentProviderDefinition>(
        snapshotProviderDefinitions.map((definition) => [definition.id, definition]),
      ),
    [snapshotProviderDefinitions],
  );
  const snapshotSelectableProviderDefinitionMap = useMemo(() => {
    const readyProviders = new Set(
      (snapshotEntries ?? [])
        .filter((entry) => entry.status === "ready")
        .map((entry) => entry.provider),
    );
    return new Map<AgentProvider, AgentProviderDefinition>(
      snapshotProviderDefinitions
        .filter((definition) => readyProviders.has(definition.id))
        .map((definition) => [definition.id, definition]),
    );
  }, [snapshotEntries, snapshotProviderDefinitions]);
  const snapshotAllProviderModels = useMemo(() => {
    const map = new Map<string, AgentModelDefinition[]>();
    for (const entry of snapshotEntries ?? []) {
      map.set(entry.provider, entry.models ?? []);
    }
    return map;
  }, [snapshotEntries]);
  const snapshotSelectedEntry = useMemo(
    () => (snapshotEntries ?? []).find((entry) => entry.provider === formState.provider) ?? null,
    [formState.provider, snapshotEntries],
  );
  const snapshotSelectedProviderModels = snapshotSelectedEntry?.models ?? null;
  const snapshotSelectedProviderModes =
    snapshotSelectedEntry?.modes ??
    snapshotProviderDefinitionMap.get(formState.provider)?.modes ??
    [];
  const providerDefinitions = snapshotProviderDefinitions;
  const providerDefinitionMap = snapshotProviderDefinitionMap;
  const selectableProviderDefinitionMap = snapshotSelectableProviderDefinitionMap;
  const allProviderModels = snapshotAllProviderModels;
  const availableModels = snapshotSelectedProviderModels;
  const modeOptions = snapshotSelectedProviderModes;
  const isAllModelsLoading = snapshotIsLoading || snapshotIsFetching;

  // Combine initialValues with initialServerId for resolution
  const combinedInitialValues = useMemo((): FormInitialValues | undefined => {
    return combineInitialValues(initialValues, initialServerId);
  }, [initialValues, initialServerId]);

  // Resolve form state when data sources change
  useEffect(() => {
    if (!isVisible || !isCreateFlow) {
      return;
    }

    // Wait for preferences to load before first resolution, unless explicit URL overrides exist.
    if (isPreferencesLoading && !hasResolvedRef.current && !combinedInitialValues) {
      return;
    }

    const resolved = resolveFormState(
      combinedInitialValues,
      preferences,
      availableModels,
      userModified,
      formStateRef.current,
      validServerIds,
      selectableProviderDefinitionMap,
    );

    // Only update if something changed
    if (
      resolved.serverId !== formStateRef.current.serverId ||
      resolved.provider !== formStateRef.current.provider ||
      resolved.modeId !== formStateRef.current.modeId ||
      resolved.model !== formStateRef.current.model ||
      resolved.thinkingOptionId !== formStateRef.current.thinkingOptionId ||
      resolved.workingDir !== formStateRef.current.workingDir
    ) {
      setFormState(resolved);
    }

    hasResolvedRef.current = true;
  }, [
    isVisible,
    isCreateFlow,
    isPreferencesLoading,
    combinedInitialValues,
    preferences,
    availableModels,
    userModified,
    validServerIds,
    selectableProviderDefinitionMap,
  ]);

  // Auto-select the first online host when:
  // - no URL override
  // - no stored preference applied
  // - user hasn't manually picked a host in this session
  useEffect(() => {
    if (!isVisible || !isCreateFlow) return;
    if (isPreferencesLoading) return;
    if (!hasResolvedRef.current) return;
    if (userModified.serverId) return;
    if (combinedInitialValues?.serverId !== undefined) return;
    if (formStateRef.current.serverId) return;

    const candidate = onlineServerIds.find((id) => validServerIds.has(id)) ?? null;
    if (!candidate) return;

    setFormState((prev) => (prev.serverId ? prev : { ...prev, serverId: candidate }));
  }, [
    combinedInitialValues?.serverId,
    isCreateFlow,
    isPreferencesLoading,
    isVisible,
    onlineServerIds.join("|"),
    userModified.serverId,
    validServerIds,
  ]);

  // User setters - mark fields as modified and persist to preferences
  const setSelectedServerIdFromUser = useCallback((value: string | null) => {
    setFormState((prev) => ({ ...prev, serverId: value }));
    setUserModified((prev) => ({ ...prev, serverId: true }));
  }, []);

  const setProviderFromUser = useCallback(
    (provider: AgentProvider) => {
      if (!selectableProviderDefinitionMap.has(provider)) {
        return;
      }
      const providerModels = allProviderModels.get(provider) ?? null;
      const providerDef = selectableProviderDefinitionMap.get(provider);
      const providerPrefs = preferences?.providerPreferences?.[provider];

      const isValidModel = (m: string) => providerModels?.some((am) => am.id === m) ?? false;
      const preferredModel = normalizeSelectedModelId(providerPrefs?.model);
      const defaultModelId = resolveDefaultModelId(providerModels);
      const nextModelId =
        preferredModel && (!providerModels || isValidModel(preferredModel))
          ? preferredModel
          : defaultModelId;

      const validModeIds = providerDef?.modes.map((m) => m.id) ?? [];
      const nextModeId =
        providerPrefs?.mode && validModeIds.includes(providerPrefs.mode)
          ? providerPrefs.mode
          : (providerDef?.defaultModeId ?? "");

      const preferredThinking = nextModelId
        ? (providerPrefs?.thinkingByModel?.[nextModelId]?.trim() ?? "")
        : "";
      const nextThinkingOptionId = resolveThinkingOptionId({
        availableModels: providerModels,
        modelId: nextModelId,
        requestedThinkingOptionId: preferredThinking,
      });

      setUserModified((prev) => ({ ...prev, provider: true }));
      void updatePreferences({ provider });

      setFormState((prev) => ({
        ...prev,
        provider,
        modeId: nextModeId,
        model: nextModelId,
        thinkingOptionId: nextThinkingOptionId,
      }));
    },
    [
      allProviderModels,
      preferences?.providerPreferences,
      selectableProviderDefinitionMap,
      updatePreferences,
    ],
  );

  const setProviderAndModelFromUser = useCallback(
    (provider: AgentProvider, modelId: string) => {
      if (!selectableProviderDefinitionMap.has(provider)) {
        return;
      }
      const providerDef = selectableProviderDefinitionMap.get(provider);
      const providerModels = allProviderModels.get(provider) ?? null;
      const normalizedModelId = normalizeSelectedModelId(modelId);
      const nextModelId = normalizedModelId || resolveDefaultModelId(providerModels);
      const nextThinkingOptionId = resolveThinkingOptionId({
        availableModels: providerModels,
        modelId: nextModelId,
        requestedThinkingOptionId: "",
      });

      setFormState((prev) => ({
        ...prev,
        provider,
        model: nextModelId,
        modeId: providerDef?.defaultModeId ?? "",
        thinkingOptionId: nextThinkingOptionId,
      }));
      setUserModified((prev) => ({ ...prev, provider: true, model: true }));
      void updatePreferences({ provider });
    },
    [allProviderModels, selectableProviderDefinitionMap, updatePreferences],
  );

  const setModeFromUser = useCallback((modeId: string) => {
    setFormState((prev) => ({ ...prev, modeId }));
    setUserModified((prev) => ({ ...prev, modeId: true }));
  }, []);

  const setModelFromUser = useCallback(
    (modelId: string) => {
      const normalizedModelId = normalizeSelectedModelId(modelId);
      const nextModelId = normalizedModelId || resolveDefaultModelId(availableModels);
      const nextThinkingOptionId = resolveThinkingOptionId({
        availableModels,
        modelId: nextModelId,
        requestedThinkingOptionId: userModified.thinkingOptionId
          ? formStateRef.current.thinkingOptionId
          : "",
      });
      setFormState((prev) => ({
        ...prev,
        model: nextModelId,
        thinkingOptionId: nextThinkingOptionId,
      }));
      setUserModified((prev) => ({ ...prev, model: true }));
    },
    [availableModels, userModified.thinkingOptionId],
  );

  const setThinkingOptionFromUser = useCallback((thinkingOptionId: string) => {
    setFormState((prev) => ({ ...prev, thinkingOptionId }));
    setUserModified((prev) => ({ ...prev, thinkingOptionId: true }));
  }, []);

  const setWorkingDir = useCallback((value: string) => {
    setFormState((prev) => ({ ...prev, workingDir: value }));
  }, []);

  const setWorkingDirFromUser = useCallback((value: string) => {
    setFormState((prev) => ({ ...prev, workingDir: value }));
    setUserModified((prev) => ({ ...prev, workingDir: true }));
  }, []);

  const setSelectedServerId = useCallback((value: string | null) => {
    setFormState((prev) => ({ ...prev, serverId: value }));
  }, []);

  const refreshProviderModels = useCallback(() => {
    refreshSnapshot();
  }, [refreshSnapshot]);

  const invalidateProviderModels = useCallback(() => {
    invalidateSnapshot();
  }, [invalidateSnapshot]);

  const persistFormPreferences = useCallback(async () => {
    const resolvedModel = resolveEffectiveModel(availableModels, formState.model);
    const modelId = resolvedModel?.id ?? formState.model;
    await updatePreferences((current) =>
      mergeProviderPreferences({
        preferences: current,
        provider: formState.provider,
        updates: {
          model: modelId || undefined,
          mode: formState.modeId || undefined,
          ...(modelId && formState.thinkingOptionId
            ? {
                thinkingByModel: {
                  [modelId]: formState.thinkingOptionId,
                },
              }
            : {}),
        } satisfies Partial<ProviderPreferences>,
      }),
    );
  }, [
    availableModels,
    formState.model,
    formState.modeId,
    formState.provider,
    formState.thinkingOptionId,
    updatePreferences,
  ]);

  const agentDefinition = providerDefinitionMap.get(formState.provider);
  const effectiveModel = resolveEffectiveModel(availableModels, formState.model);
  const resolvedModelId = effectiveModel?.id ?? formState.model;
  const availableThinkingOptions = effectiveModel?.thinkingOptions ?? [];
  const isModelLoading = snapshotIsLoading || snapshotIsFetching;
  const modelError = snapshotError;

  const workingDirIsEmpty = !formState.workingDir.trim();

  return useMemo(
    () => ({
      selectedServerId: formState.serverId,
      setSelectedServerId,
      setSelectedServerIdFromUser,
      selectedProvider: formState.provider,
      setProviderFromUser,
      selectedMode: formState.modeId,
      setModeFromUser,
      selectedModel: resolvedModelId,
      setModelFromUser,
      selectedThinkingOptionId: formState.thinkingOptionId,
      setThinkingOptionFromUser,
      workingDir: formState.workingDir,
      setWorkingDir,
      setWorkingDirFromUser,
      providerDefinitions,
      providerDefinitionMap,
      agentDefinition,
      allProviderEntries,
      modeOptions,
      availableModels: availableModels ?? [],
      allProviderModels,
      isAllModelsLoading,
      availableThinkingOptions,
      isModelLoading,
      modelError,
      refreshProviderModels,
      invalidateProviderModels,
      setProviderAndModelFromUser,
      workingDirIsEmpty,
      persistFormPreferences,
    }),
    [
      formState.serverId,
      formState.provider,
      formState.modeId,
      resolvedModelId,
      formState.thinkingOptionId,
      formState.workingDir,
      setSelectedServerId,
      setSelectedServerIdFromUser,
      setProviderFromUser,
      setModeFromUser,
      setModelFromUser,
      setThinkingOptionFromUser,
      setWorkingDir,
      setWorkingDirFromUser,
      providerDefinitions,
      providerDefinitionMap,
      agentDefinition,
      allProviderEntries,
      modeOptions,
      availableModels,
      allProviderModels,
      isAllModelsLoading,
      availableThinkingOptions,
      isModelLoading,
      modelError,
      refreshProviderModels,
      invalidateProviderModels,
      setProviderAndModelFromUser,
      workingDirIsEmpty,
      persistFormPreferences,
    ],
  );
}

// Re-export for backwards compatibility
export type CreateAgentInitialValues = FormInitialValues;

export const __private__ = {
  combineInitialValues,
  resolveDefaultModel,
  resolveFormState,
  resolveThinkingOptionId,
};
