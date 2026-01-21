import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useFormPreferences, type FormPreferences } from "./use-form-preferences";

// Explicit overrides from URL params or "New Agent" button
export interface FormInitialValues {
  serverId?: string | null;
  provider?: AgentProvider;
  modeId?: string | null;
  model?: string | null;
  workingDir?: string;
}

// Tracks which fields the user has explicitly modified in this session
interface UserModifiedFields {
  serverId: boolean;
  provider: boolean;
  modeId: boolean;
  model: boolean;
  workingDir: boolean;
}

const INITIAL_USER_MODIFIED: UserModifiedFields = {
  serverId: false,
  provider: false,
  modeId: false,
  model: false,
  workingDir: false,
};

// Internal form state
interface FormState {
  serverId: string | null;
  provider: AgentProvider;
  modeId: string;
  model: string;
  workingDir: string;
}

type UseAgentFormStateOptions = {
  initialServerId?: string | null;
  initialValues?: FormInitialValues;
  isVisible?: boolean;
  isCreateFlow?: boolean;
  isTargetDaemonReady?: boolean;
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
  workingDir: string;
  setWorkingDir: (value: string) => void;
  setWorkingDirFromUser: (value: string) => void;
  providerDefinitions: AgentProviderDefinition[];
  providerDefinitionMap: Map<AgentProvider, AgentProviderDefinition>;
  agentDefinition?: AgentProviderDefinition;
  modeOptions: AgentMode[];
  availableModels: AgentModelDefinition[];
  isModelLoading: boolean;
  modelError: string | null;
  refreshProviderModels: () => void;
  queueProviderModelFetch: (
    serverId: string | null,
    options?: { cwd?: string; delayMs?: number }
  ) => void;
  clearQueuedProviderModelRequest: (serverId: string | null) => void;
  workingDirIsEmpty: boolean;
  persistFormPreferences: () => Promise<void>;
};

const providerDefinitions = AGENT_PROVIDER_DEFINITIONS;
const providerDefinitionMap = new Map<AgentProvider, AgentProviderDefinition>(
  providerDefinitions.map((definition) => [definition.id, definition])
);
const fallbackDefinition = providerDefinitions[0];
const DEFAULT_PROVIDER: AgentProvider = fallbackDefinition?.id ?? "claude";
const DEFAULT_MODE_FOR_DEFAULT_PROVIDER =
  fallbackDefinition?.defaultModeId ?? "";

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
  currentState: FormState
): FormState {
  // Start with current state - we only update non-user-modified fields
  const result = { ...currentState };

  // 1. Resolve provider first (other fields depend on it)
  if (!userModified.provider) {
    if (initialValues?.provider && providerDefinitionMap.has(initialValues.provider)) {
      result.provider = initialValues.provider;
    } else if (
      preferences?.provider &&
      providerDefinitionMap.has(preferences.provider as AgentProvider)
    ) {
      result.provider = preferences.provider as AgentProvider;
    }
    // else keep current (initialized to DEFAULT_PROVIDER)
  }

  const providerDef = providerDefinitionMap.get(result.provider);
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

    if (
      typeof initialValues?.model === "string" &&
      initialValues.model.length > 0
    ) {
      // If models aren't loaded yet, trust the initial value
      // It will be validated once models load
      if (!availableModels || isValidModel(initialValues.model)) {
        result.model = initialValues.model;
      } else if (providerPrefs?.model && isValidModel(providerPrefs.model)) {
        result.model = providerPrefs.model;
      } else {
        result.model = "";
      }
    } else if (typeof providerPrefs?.model === "string" && providerPrefs.model.length > 0) {
      // If models haven't loaded yet, optimistically apply the stored preference.
      // We'll validate once models load and clear it if it isn't available.
      if (!availableModels || isValidModel(providerPrefs.model)) {
        result.model = providerPrefs.model;
      } else {
        result.model = "";
      }
    } else {
      result.model = "";
    }
  }

  // 4. Resolve serverId (independent)
  if (!userModified.serverId) {
    if (initialValues?.serverId !== undefined) {
      result.serverId = initialValues.serverId;
    } else if (preferences?.serverId) {
      result.serverId = preferences.serverId;
    }
    // else keep current
  }

  // 5. Resolve workingDir (independent)
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
  } = options;

  const {
    preferences,
    isLoading: isPreferencesLoading,
    updatePreferences,
    updateProviderPreferences,
  } = useFormPreferences();

  // Track which fields the user has explicitly modified
  const [userModified, setUserModified] = useState<UserModifiedFields>(INITIAL_USER_MODIFIED);

  // Form state
  const [formState, setFormState] = useState<FormState>(() => ({
    serverId: initialServerId,
    provider: DEFAULT_PROVIDER,
    modeId: DEFAULT_MODE_FOR_DEFAULT_PROVIDER,
    model: "",
    workingDir: "",
  }));

  // Track if we've done initial resolution (to avoid flickering)
  const hasResolvedRef = useRef(false);

  // Reset user modifications when form becomes invisible
  useEffect(() => {
    if (!isVisible) {
      setUserModified(INITIAL_USER_MODIFIED);
      hasResolvedRef.current = false;
    }
  }, [isVisible]);

  // Get session state for provider models
  const sessionState = useSessionStore((state) =>
    formState.serverId ? state.sessions[formState.serverId] : undefined
  );
  const providerModels = sessionState?.providerModels;
  const requestProviderModels = sessionState?.methods?.requestProviderModels;
  const getSessionState = useCallback(
    (serverId: string) => useSessionStore.getState().sessions[serverId] ?? null,
    []
  );

  // Get available models for current provider
  const modelState = providerModels?.get(formState.provider);
  const availableModels = modelState?.models ?? null;

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
      formState
    );

    // Only update if something changed
    if (
      resolved.serverId !== formState.serverId ||
      resolved.provider !== formState.provider ||
      resolved.modeId !== formState.modeId ||
      resolved.model !== formState.model ||
      resolved.workingDir !== formState.workingDir
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
    formState,
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

  // Provider model request timers
  const providerModelRequestTimersRef = useRef<
    Map<string, ReturnType<typeof setTimeout>>
  >(new Map());

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
        model: providerPrefs?.model ?? "",
      }));
    },
    [preferences?.providerPreferences, updatePreferences]
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
      setFormState((prev) => ({ ...prev, model: modelId }));
      setUserModified((prev) => ({ ...prev, model: true }));
      void updateProviderPreferences(formState.provider, { model: modelId });
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
    if (!requestProviderModels) {
      return;
    }
    const trimmed = formState.workingDir.trim();
    requestProviderModels(formState.provider, {
      cwd: trimmed.length > 0 ? trimmed : undefined,
    });
  }, [requestProviderModels, formState.provider, formState.workingDir]);

  const persistFormPreferences = useCallback(async () => {
    await updatePreferences({
      workingDir: formState.workingDir,
      provider: formState.provider,
      serverId: formState.serverId ?? undefined,
    });
    await updateProviderPreferences(formState.provider, {
      mode: formState.modeId,
      model: formState.model,
    });
  }, [
    formState.modeId,
    formState.model,
    formState.provider,
    formState.serverId,
    formState.workingDir,
    updatePreferences,
    updateProviderPreferences,
  ]);

  const clearQueuedProviderModelRequest = useCallback((serverId: string | null) => {
    if (!serverId) {
      return;
    }
    const timer = providerModelRequestTimersRef.current.get(serverId);
    if (timer) {
      clearTimeout(timer);
      providerModelRequestTimersRef.current.delete(serverId);
    }
  }, []);

  const queueProviderModelFetch = useCallback(
    (
      serverId: string | null,
      options?: { cwd?: string; delayMs?: number }
    ) => {
      if (!serverId || !getSessionState) {
        clearQueuedProviderModelRequest(serverId);
        return;
      }

      const sessionState = getSessionState(serverId);
      if (!sessionState?.connection?.isConnected) {
        clearQueuedProviderModelRequest(serverId);
        return;
      }

      const currentState = sessionState.providerModels?.get(formState.provider);
      if (currentState?.models?.length || currentState?.isLoading) {
        clearQueuedProviderModelRequest(serverId);
        return;
      }

      const delayMs = options?.delayMs ?? 0;
      const trigger = () => {
        providerModelRequestTimersRef.current.delete(serverId);
        sessionState.methods?.requestProviderModels(formState.provider, {
          ...(options?.cwd ? { cwd: options.cwd } : {}),
        });
      };
      clearQueuedProviderModelRequest(serverId);
      if (delayMs > 0) {
        providerModelRequestTimersRef.current.set(serverId, setTimeout(trigger, delayMs));
      } else {
        trigger();
      }
    },
    [clearQueuedProviderModelRequest, getSessionState, formState.provider]
  );

  useEffect(() => {
    return () => {
      providerModelRequestTimersRef.current.forEach((timer) => {
        clearTimeout(timer);
      });
      providerModelRequestTimersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!isVisible || !isTargetDaemonReady || !formState.serverId) {
      clearQueuedProviderModelRequest(formState.serverId);
      return;
    }
    const trimmed = formState.workingDir.trim();
    queueProviderModelFetch(formState.serverId, {
      cwd: trimmed.length > 0 ? trimmed : undefined,
      delayMs: 180,
    });
    return () => {
      clearQueuedProviderModelRequest(formState.serverId);
    };
  }, [
    clearQueuedProviderModelRequest,
    isTargetDaemonReady,
    isVisible,
    queueProviderModelFetch,
    formState.serverId,
    formState.workingDir,
  ]);

  const agentDefinition = providerDefinitionMap.get(formState.provider);
  const modeOptions = agentDefinition?.modes ?? [];
  const isModelLoading = modelState?.isLoading ?? false;
  const modelError = modelState?.error ?? null;

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
      workingDir: formState.workingDir,
      setWorkingDir,
      setWorkingDirFromUser,
      providerDefinitions,
      providerDefinitionMap,
      agentDefinition,
      modeOptions,
      availableModels: availableModels ?? [],
      isModelLoading,
      modelError,
      refreshProviderModels,
      queueProviderModelFetch,
      clearQueuedProviderModelRequest,
      workingDirIsEmpty,
      persistFormPreferences,
    }),
    [
      formState.serverId,
      formState.provider,
      formState.modeId,
      formState.model,
      formState.workingDir,
      setSelectedServerId,
      setSelectedServerIdFromUser,
      setProviderFromUser,
      setModeFromUser,
      setModelFromUser,
      setWorkingDir,
      setWorkingDirFromUser,
      agentDefinition,
      modeOptions,
      availableModels,
      isModelLoading,
      modelError,
      refreshProviderModels,
      queueProviderModelFetch,
      clearQueuedProviderModelRequest,
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
