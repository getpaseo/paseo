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
import type { ProviderModelState } from "@/stores/session-store";
import { useSessionStore } from "@/stores/session-store";
import { useFormPreferences } from "./use-form-preferences";

export type CreateAgentInitialValues = {
  workingDir?: string;
  provider?: AgentProvider;
  modeId?: string | null;
  model?: string | null;
};

type UseAgentFormStateOptions = {
  initialServerId?: string | null;
  initialValues?: CreateAgentInitialValues;
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
    getProviderPreferences,
    updatePreferences,
    updateProviderPreferences,
  } = useFormPreferences();

  const [selectedServerId, setSelectedServerId] = useState<string | null>(
    initialServerId
  );
  const [workingDir, setWorkingDir] = useState("");
  const [selectedProvider, setSelectedProvider] =
    useState<AgentProvider>(DEFAULT_PROVIDER);
  const [selectedMode, setSelectedMode] = useState(
    DEFAULT_MODE_FOR_DEFAULT_PROVIDER
  );
  const [selectedModel, setSelectedModel] = useState("");

  const hasHydratedRef = useRef(false);
  const hasAppliedInitialValuesRef = useRef(false);
  const providerModelRequestTimersRef = useRef<
    Map<string, ReturnType<typeof setTimeout>>
  >(new Map());
  const sessionState = useSessionStore((state) =>
    selectedServerId ? state.sessions[selectedServerId] : undefined
  );
  const providerModels = sessionState?.providerModels;
  const requestProviderModels = sessionState?.methods?.requestProviderModels;
  const getSessionState = useCallback(
    (serverId: string) => useSessionStore.getState().sessions[serverId] ?? null,
    []
  );

  const setSelectedServerIdFromUser = useCallback(
    (value: string | null) => {
      setSelectedServerId(value);
      void updatePreferences({ serverId: value ?? undefined });
    },
    [updatePreferences]
  );

  const setProviderFromUser = useCallback(
    (provider: AgentProvider) => {
      setSelectedProvider(provider);
      void updatePreferences({ provider });

      // Restore per-provider preferences if available
      const providerPrefs = getProviderPreferences(provider);
      const providerDef = providerDefinitionMap.get(provider);

      setSelectedModel(providerPrefs?.model ?? "");
      setSelectedMode(providerPrefs?.mode ?? providerDef?.defaultModeId ?? "");
    },
    [getProviderPreferences, updatePreferences]
  );

  const setModeFromUser = useCallback(
    (modeId: string) => {
      setSelectedMode(modeId);
      void updateProviderPreferences(selectedProvider, { mode: modeId });
    },
    [selectedProvider, updateProviderPreferences]
  );

  const setModelFromUser = useCallback(
    (modelId: string) => {
      setSelectedModel(modelId);
      void updateProviderPreferences(selectedProvider, { model: modelId });
    },
    [selectedProvider, updateProviderPreferences]
  );

  const setWorkingDirFromUser = useCallback(
    (value: string) => {
      setWorkingDir(value);
      void updatePreferences({ workingDir: value });
    },
    [updatePreferences]
  );

  const applyInitialValues = useCallback(() => {
    if (!isCreateFlow || !initialValues) {
      return;
    }

    if (Object.prototype.hasOwnProperty.call(initialValues, "workingDir")) {
      setWorkingDir(initialValues.workingDir ?? "");
    }

    if (initialValues.provider && providerDefinitionMap.has(initialValues.provider)) {
      setSelectedProvider(initialValues.provider);
    }

    if (typeof initialValues.modeId === "string" && initialValues.modeId.length > 0) {
      setSelectedMode(initialValues.modeId);
    }

    if (typeof initialValues.model === "string" && initialValues.model.length > 0) {
      setSelectedModel(initialValues.model);
    }
  }, [initialValues, isCreateFlow]);

  useEffect(() => {
    if (!isVisible) {
      hasAppliedInitialValuesRef.current = false;
      return;
    }
    if (hasAppliedInitialValuesRef.current) {
      return;
    }
    applyInitialValues();
    hasAppliedInitialValuesRef.current = true;
  }, [applyInitialValues, isVisible]);

  const refreshProviderModels = useCallback(() => {
    if (!requestProviderModels) {
      return;
    }
    const trimmed = workingDir.trim();
    requestProviderModels(selectedProvider, {
      cwd: trimmed.length > 0 ? trimmed : undefined,
    });
  }, [requestProviderModels, selectedProvider, workingDir]);

  // Hydrate form state from preferences once loaded
  useEffect(() => {
    if (isPreferencesLoading || hasHydratedRef.current) return;
    hasHydratedRef.current = true;

    const activeProvider =
      preferences.provider &&
      providerDefinitionMap.has(preferences.provider as AgentProvider)
        ? (preferences.provider as AgentProvider)
        : DEFAULT_PROVIDER;

    const providerPrefs = preferences.providerPreferences?.[activeProvider];
    const providerDef = providerDefinitionMap.get(activeProvider);

    setSelectedProvider(activeProvider);
    if (preferences.workingDir) setWorkingDir(preferences.workingDir);
    setSelectedMode(providerPrefs?.mode ?? providerDef?.defaultModeId ?? "");
    if (providerPrefs?.model) setSelectedModel(providerPrefs.model);
    if (preferences.serverId) setSelectedServerId(preferences.serverId);
  }, [isPreferencesLoading, preferences]);

  const persistFormPreferences = useCallback(async () => {
    await updatePreferences({
      workingDir,
      provider: selectedProvider,
      serverId: selectedServerId ?? undefined,
    });
    await updateProviderPreferences(selectedProvider, {
      mode: selectedMode,
      model: selectedModel,
    });
  }, [
    selectedMode,
    selectedModel,
    selectedProvider,
    selectedServerId,
    workingDir,
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

      const currentState = sessionState.providerModels?.get(selectedProvider);
      if (currentState?.models?.length || currentState?.isLoading) {
        clearQueuedProviderModelRequest(serverId);
        return;
      }

      const delayMs = options?.delayMs ?? 0;
      const trigger = () => {
        providerModelRequestTimersRef.current.delete(serverId);
        sessionState.methods?.requestProviderModels(selectedProvider, {
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
    [clearQueuedProviderModelRequest, getSessionState, selectedProvider]
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
    if (!isVisible || !isTargetDaemonReady || !selectedServerId) {
      clearQueuedProviderModelRequest(selectedServerId);
      return;
    }
    const trimmed = workingDir.trim();
    queueProviderModelFetch(selectedServerId, {
      cwd: trimmed.length > 0 ? trimmed : undefined,
      delayMs: 180,
    });
    return () => {
      clearQueuedProviderModelRequest(selectedServerId);
    };
  }, [
    clearQueuedProviderModelRequest,
    isTargetDaemonReady,
    isVisible,
    queueProviderModelFetch,
    selectedServerId,
    workingDir,
  ]);

  const agentDefinition = providerDefinitionMap.get(selectedProvider);
  const modeOptions = agentDefinition?.modes ?? [];
  const modelState = providerModels?.get(selectedProvider);
  const availableModels = modelState?.models ?? [];
  const isModelLoading = modelState?.isLoading ?? false;
  const modelError = modelState?.error ?? null;

  useEffect(() => {
    if (!agentDefinition) {
      return;
    }

    if (modeOptions.length === 0) {
      if (selectedMode !== "") {
        setSelectedMode("");
      }
      return;
    }

    const availableModeIds = modeOptions.map((mode) => mode.id);
    if (!availableModeIds.includes(selectedMode)) {
      const fallbackModeId = agentDefinition.defaultModeId ?? availableModeIds[0];
      setSelectedMode(fallbackModeId);
    }
  }, [agentDefinition, modeOptions, selectedMode]);

  const workingDirIsEmpty = !workingDir.trim();

  return useMemo(
    () => ({
      selectedServerId,
      setSelectedServerId,
      setSelectedServerIdFromUser,
      selectedProvider,
      setProviderFromUser,
      selectedMode,
      setModeFromUser,
      selectedModel,
      setModelFromUser,
      workingDir,
      setWorkingDir,
      setWorkingDirFromUser,
      providerDefinitions,
      providerDefinitionMap,
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
    }),
    [
      agentDefinition,
      availableModels,
      isModelLoading,
      modelError,
      modeOptions,
      queueProviderModelFetch,
      clearQueuedProviderModelRequest,
      refreshProviderModels,
      selectedMode,
      selectedModel,
      selectedProvider,
      selectedServerId,
      setSelectedServerIdFromUser,
      setProviderFromUser,
      setModeFromUser,
      setModelFromUser,
      setWorkingDirFromUser,
      workingDir,
      workingDirIsEmpty,
      persistFormPreferences,
    ]
  );
}
