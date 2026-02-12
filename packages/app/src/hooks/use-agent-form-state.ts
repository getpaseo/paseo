import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AGENT_PROVIDER_DEFINITIONS,
  type AgentProviderDefinition,
} from "@server/server/agent/provider-manifest";
import type {
  AgentMode,
  AgentModelDefinition,
  AgentProvider,
} from "@server/server/agent/agent-sdk-types";
import { useSessionStore } from "@/stores/session-store";
import { useDaemonRegistry } from "@/contexts/daemon-registry-context";
import { useFormPreferences, type FormPreferences } from "./use-form-preferences";

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
  modeOptions: AgentMode[];
  availableModels: AgentModelDefinition[];
  availableThinkingOptions: NonNullable<AgentModelDefinition["thinkingOptions"]>;
  isModelLoading: boolean;
  modelError: string | null;
  refreshProviderModels: () => void;
  workingDirIsEmpty: boolean;
  persistFormPreferences: () => Promise<void>;
};

const allProviderDefinitions = AGENT_PROVIDER_DEFINITIONS;
const allProviderDefinitionMap = new Map<AgentProvider, AgentProviderDefinition>(
  allProviderDefinitions.map((definition) => [definition.id, definition])
);
const fallbackDefinition = allProviderDefinitions[0];
const DEFAULT_PROVIDER: AgentProvider = fallbackDefinition?.id ?? "claude";
const DEFAULT_MODE_FOR_DEFAULT_PROVIDER =
  fallbackDefinition?.defaultModeId ?? "";

function normalizeSelectedModelId(
  modelId: string | null | undefined
): string {
  const normalized = typeof modelId === "string" ? modelId.trim() : "";
  if (!normalized || normalized.toLowerCase() === "default") {
    return "";
  }
  return normalized;
}

function resolveDefaultModel(
  availableModels: AgentModelDefinition[] | null
): AgentModelDefinition | null {
  if (!availableModels || availableModels.length === 0) {
    return null;
  }
  return availableModels.find((model) => model.isDefault) ?? availableModels[0] ?? null;
}

function resolveEffectiveModel(
  availableModels: AgentModelDefinition[] | null,
  modelId: string
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

/**
 * Pure function that resolves form state from multiple data sources.
 * Priority: explicit (URL params) > preferences > provider defaults > fallback
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
  allowedProviderMap: Map<AgentProvider, AgentProviderDefinition> = allProviderDefinitionMap
): FormState {
  // Start with current state - we only update non-user-modified fields
  const result = { ...currentState };
  const fallbackProvider = allowedProviderMap.keys().next().value as
    | AgentProvider
    | undefined;

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
    } else if (
      providerPrefs?.mode &&
      validModeIds.includes(providerPrefs.mode)
    ) {
      result.modeId = providerPrefs.mode;
    } else {
      result.modeId = providerDef?.defaultModeId ?? validModeIds[0] ?? "";
    }
  }

  // 3. Resolve model (depends on provider + availableModels)
  if (!userModified.model) {
    const isValidModel = (m: string) =>
      availableModels?.some((am) => am.id === m) ?? false;
    const initialModel = normalizeSelectedModelId(initialValues?.model);
    const preferredModel = normalizeSelectedModelId(providerPrefs?.model);

    if (initialModel) {
      // If models aren't loaded yet, trust the initial value
      // It will be validated once models load
      if (!availableModels || isValidModel(initialModel)) {
        result.model = initialModel;
      } else if (preferredModel && isValidModel(preferredModel)) {
        result.model = preferredModel;
      } else {
        result.model = "";
      }
    } else if (preferredModel) {
      // If models haven't loaded yet, optimistically apply the stored preference.
      // We'll validate once models load and clear it if it isn't available.
      if (!availableModels || isValidModel(preferredModel)) {
        result.model = preferredModel;
      } else {
        result.model = "";
      }
    } else {
      result.model = "";
    }
  }

  // 4. Resolve thinking option (depends on effective model)
  const initialThinkingOptionId =
    typeof initialValues?.thinkingOptionId === "string"
      ? initialValues.thinkingOptionId.trim()
      : "";
  const preferredThinkingOptionId =
    providerPrefs?.thinkingOptionId?.trim() ?? "";

  if (!userModified.thinkingOptionId) {
    if (initialThinkingOptionId.length > 0) {
      result.thinkingOptionId = initialThinkingOptionId;
    } else if (preferredThinkingOptionId.length > 0) {
      result.thinkingOptionId = preferredThinkingOptionId;
    } else {
      result.thinkingOptionId = "";
    }
  }

  // Validate thinking option once model metadata is available.
  if (availableModels) {
    const effectiveModel = resolveEffectiveModel(availableModels, result.model);
    const thinkingOptions = effectiveModel?.thinkingOptions ?? [];
    if (thinkingOptions.length === 0) {
      result.thinkingOptionId = "";
    } else {
      const thinkingIds = new Set(thinkingOptions.map((option) => option.id));
      const defaultThinkingOptionId =
        effectiveModel?.defaultThinkingOptionId ??
        thinkingOptions[0]?.id ??
        "";
      if (!result.thinkingOptionId || !thinkingIds.has(result.thinkingOptionId)) {
        result.thinkingOptionId = defaultThinkingOptionId;
      }
    }
  }

  // 5. Resolve serverId (independent)
  // Only use stored serverId if the host still exists in the registry
  if (!userModified.serverId) {
    if (initialValues?.serverId !== undefined) {
      result.serverId = initialValues.serverId;
    } else if (preferences?.serverId && validServerIds.has(preferences.serverId)) {
      result.serverId = preferences.serverId;
    }
    // else keep current
  }

  // 6. Resolve workingDir (independent)
  if (!userModified.workingDir) {
    if (initialValues?.workingDir !== undefined) {
      result.workingDir = initialValues.workingDir;
    } else if (preferences?.workingDir) {
      result.workingDir = preferences.workingDir;
    }
    // else keep current (empty string)
  }

  return result;
}

function combineInitialValues(
  initialValues: FormInitialValues | undefined,
  initialServerId: string | null
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

export function useAgentFormState(
  options: UseAgentFormStateOptions = {}
): UseAgentFormStateResult {
  const {
    initialServerId = null,
    initialValues,
    isVisible = true,
    isCreateFlow = true,
    isTargetDaemonReady = true,
    onlineServerIds = [],
  } = options;

  const {
    preferences,
    isLoading: isPreferencesLoading,
    updatePreferences,
    updateProviderPreferences,
  } = useFormPreferences();

  const { daemons } = useDaemonRegistry();

  // Build a set of valid server IDs for preference validation
  const validServerIds = useMemo(
    () => new Set(daemons.map((d) => d.serverId)),
    [daemons]
  );

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

  // Session state for provider model listing
  const sessionState = useSessionStore((state) =>
    formState.serverId ? state.sessions[formState.serverId] : undefined
  );
  const client = sessionState?.client ?? null;
  const isConnected = sessionState?.connection?.isConnected ?? false;

  const availableProvidersQuery = useQuery({
    queryKey: ["availableProviders", formState.serverId],
    enabled: Boolean(
      isVisible && isTargetDaemonReady && formState.serverId && client && isConnected
    ),
    staleTime: 60 * 1000,
    queryFn: async () => {
      if (!client) {
        throw new Error("Host is not connected");
      }
      const payload = await client.listAvailableProviders();
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.providers
        .filter((entry) => entry.available)
        .map((entry) => entry.provider);
    },
  });

  const providerDefinitions = useMemo(() => {
    const availableProviders = availableProvidersQuery.data;
    if (!availableProviders) {
      return [];
    }
    const available = new Set(availableProviders);
    return allProviderDefinitions.filter((definition) =>
      available.has(definition.id as AgentProvider)
    );
  }, [availableProvidersQuery.data]);

  const providerDefinitionMap = useMemo(
    () =>
      new Map<AgentProvider, AgentProviderDefinition>(
        providerDefinitions.map((definition) => [definition.id as AgentProvider, definition])
      ),
    [providerDefinitions]
  );

  const [debouncedCwd, setDebouncedCwd] = useState<string | undefined>(undefined);
  useEffect(() => {
    const trimmed = formState.workingDir.trim();
    const next = trimmed.length > 0 ? trimmed : undefined;
    const timer = setTimeout(() => setDebouncedCwd(next), 180);
    return () => clearTimeout(timer);
  }, [formState.workingDir]);

  const providerModelsQuery = useQuery({
    queryKey: ["providerModels", formState.serverId, formState.provider, debouncedCwd],
    enabled: Boolean(
      isVisible &&
        isTargetDaemonReady &&
        formState.serverId &&
        client &&
        isConnected &&
        providerDefinitionMap.has(formState.provider)
    ),
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      if (!client) {
        throw new Error("Host is not connected");
      }
      const payload = await client.listProviderModels(formState.provider, {
        cwd: debouncedCwd,
      });
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.models ?? [];
    },
  });

  const availableModels = providerModelsQuery.data ?? null;

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
      providerDefinitionMap
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
    providerDefinitionMap,
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

  // Persist inferred serverId so reloads keep the selection (e.g. URL serverId or first-time load).
  useEffect(() => {
    if (!isVisible || !isCreateFlow) return;
    if (isPreferencesLoading) return;
    if (userModified.serverId) return;
    const serverId = formState.serverId;
    if (!serverId) return;
    if (preferences?.serverId === serverId) return;
    void updatePreferences({ serverId });
  }, [
    isVisible,
    isCreateFlow,
    isPreferencesLoading,
    userModified.serverId,
    formState.serverId,
    preferences?.serverId,
    updatePreferences,
  ]);

  // User setters - mark fields as modified and persist to preferences
  const setSelectedServerIdFromUser = useCallback(
    (value: string | null) => {
      setFormState((prev) => ({ ...prev, serverId: value }));
      setUserModified((prev) => ({ ...prev, serverId: true }));
      void updatePreferences({ serverId: value ?? undefined });
    },
    [updatePreferences]
  );

  const setProviderFromUser = useCallback(
    (provider: AgentProvider) => {
      setFormState((prev) => ({ ...prev, provider }));
      setUserModified((prev) => ({ ...prev, provider: true }));
      void updatePreferences({ provider });

      // When provider changes, reset mode and model to provider defaults
      // (unless user has explicitly set them)
      const providerDef = providerDefinitionMap.get(provider);
      const providerPrefs = preferences?.providerPreferences?.[provider];

      setFormState((prev) => ({
        ...prev,
        provider,
        modeId: providerPrefs?.mode ?? providerDef?.defaultModeId ?? "",
        model: normalizeSelectedModelId(providerPrefs?.model),
        thinkingOptionId: providerPrefs?.thinkingOptionId ?? "",
      }));
    },
    [preferences?.providerPreferences, providerDefinitionMap, updatePreferences]
  );

  const setModeFromUser = useCallback(
    (modeId: string) => {
      setFormState((prev) => ({ ...prev, modeId }));
      setUserModified((prev) => ({ ...prev, modeId: true }));
      void updateProviderPreferences(formState.provider, { mode: modeId });
    },
    [formState.provider, updateProviderPreferences]
  );

  const setModelFromUser = useCallback(
    (modelId: string) => {
      const normalizedModelId = normalizeSelectedModelId(modelId);
      setFormState((prev) => ({ ...prev, model: normalizedModelId }));
      setUserModified((prev) => ({ ...prev, model: true }));
      void updateProviderPreferences(formState.provider, { model: normalizedModelId });
    },
    [formState.provider, updateProviderPreferences]
  );

  const setThinkingOptionFromUser = useCallback(
    (thinkingOptionId: string) => {
      setFormState((prev) => ({ ...prev, thinkingOptionId }));
      setUserModified((prev) => ({ ...prev, thinkingOptionId: true }));
      void updateProviderPreferences(formState.provider, { thinkingOptionId });
    },
    [formState.provider, updateProviderPreferences]
  );

  const setWorkingDir = useCallback((value: string) => {
    setFormState((prev) => ({ ...prev, workingDir: value }));
  }, []);

  const setWorkingDirFromUser = useCallback(
    (value: string) => {
      setFormState((prev) => ({ ...prev, workingDir: value }));
      setUserModified((prev) => ({ ...prev, workingDir: true }));
      void updatePreferences({ workingDir: value });
    },
    [updatePreferences]
  );

  const setSelectedServerId = useCallback((value: string | null) => {
    setFormState((prev) => ({ ...prev, serverId: value }));
  }, []);

  const refreshProviderModels = useCallback(() => {
    void providerModelsQuery.refetch();
  }, [providerModelsQuery]);

  const persistFormPreferences = useCallback(async () => {
    const providerPreferenceUpdates: {
      mode: string;
      model: string;
      thinkingOptionId?: string;
    } = {
      mode: formState.modeId,
      model: formState.model,
    };
    if (userModified.thinkingOptionId) {
      providerPreferenceUpdates.thinkingOptionId = formState.thinkingOptionId;
    }

    await updatePreferences({
      workingDir: formState.workingDir,
      provider: formState.provider,
      serverId: formState.serverId ?? undefined,
    });
    await updateProviderPreferences(formState.provider, providerPreferenceUpdates);
  }, [
    formState.modeId,
    formState.model,
    formState.provider,
    formState.serverId,
    formState.thinkingOptionId,
    formState.workingDir,
    userModified.thinkingOptionId,
    updatePreferences,
    updateProviderPreferences,
  ]);

  const agentDefinition = providerDefinitionMap.get(formState.provider);
  const modeOptions = agentDefinition?.modes ?? [];
  const effectiveModel = resolveEffectiveModel(availableModels, formState.model);
  const availableThinkingOptions = effectiveModel?.thinkingOptions ?? [];
  const isModelLoading = providerModelsQuery.isLoading || providerModelsQuery.isFetching;
  const modelError =
    providerModelsQuery.error instanceof Error ? providerModelsQuery.error.message : null;

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
      selectedModel: formState.model,
      setModelFromUser,
      selectedThinkingOptionId: formState.thinkingOptionId,
      setThinkingOptionFromUser,
      workingDir: formState.workingDir,
      setWorkingDir,
      setWorkingDirFromUser,
      providerDefinitions,
      providerDefinitionMap,
      agentDefinition,
      modeOptions,
      availableModels: availableModels ?? [],
      availableThinkingOptions,
      isModelLoading,
      modelError,
      refreshProviderModels,
      workingDirIsEmpty,
      persistFormPreferences,
    }),
    [
      formState.serverId,
      formState.provider,
      formState.modeId,
      formState.model,
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
      modeOptions,
      availableModels,
      availableThinkingOptions,
      isModelLoading,
      modelError,
      refreshProviderModels,
      workingDirIsEmpty,
      persistFormPreferences,
    ]
  );
}

// Re-export for backwards compatibility
export type CreateAgentInitialValues = FormInitialValues;

export const __private__ = {
  combineInitialValues,
  resolveFormState,
};
