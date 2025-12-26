import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  AGENT_PROVIDER_DEFINITIONS,
  type AgentProviderDefinition,
} from "@server/server/agent/provider-manifest";
import type {
  AgentMode,
  AgentModelDefinition,
  AgentProvider,
} from "@server/server/agent/agent-sdk-types";
import type { WSInboundMessage } from "@server/server/messages";
import type { ProviderModelState } from "@/stores/session-store";
import { useSessionStore } from "@/stores/session-store";
import { generateMessageId } from "@/types/stream";

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
  userEditedPreferencesRef: React.MutableRefObject<{
    provider: boolean;
    mode: boolean;
    model: boolean;
    workingDir: boolean;
    serverId: boolean;
  }>;
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
};

const FORM_PREFERENCES_STORAGE_KEY = "@paseo:create-agent-preferences";

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

  const formPreferencesHydratedRef = useRef(false);
  const userEditedPreferencesRef = useRef({
    provider: false,
    mode: false,
    model: false,
    workingDir: false,
    serverId: false,
  });
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

  const setSelectedServerIdFromUser = useCallback((value: string | null) => {
    userEditedPreferencesRef.current.serverId = true;
    setSelectedServerId(value);
  }, []);

  const setProviderFromUser = useCallback((provider: AgentProvider) => {
    userEditedPreferencesRef.current.provider = true;
    setSelectedProvider(provider);
    userEditedPreferencesRef.current.model = true;
    setSelectedModel("");
  }, []);

  const setModeFromUser = useCallback((modeId: string) => {
    userEditedPreferencesRef.current.mode = true;
    setSelectedMode(modeId);
  }, []);

  const setModelFromUser = useCallback((modelId: string) => {
    userEditedPreferencesRef.current.model = true;
    setSelectedModel(modelId);
  }, []);

  const setWorkingDirFromUser = useCallback((value: string) => {
    userEditedPreferencesRef.current.workingDir = true;
    setWorkingDir(value);
  }, []);

  const applyInitialValues = useCallback(() => {
    if (!isCreateFlow || !initialValues) {
      return;
    }

    if (Object.prototype.hasOwnProperty.call(initialValues, "workingDir")) {
      const providedWorkingDir = initialValues.workingDir ?? "";
      userEditedPreferencesRef.current.workingDir = true;
      setWorkingDir(providedWorkingDir);
    }

    if (initialValues.provider && providerDefinitionMap.has(initialValues.provider)) {
      userEditedPreferencesRef.current.provider = true;
      setSelectedProvider(initialValues.provider);
    }

    if (typeof initialValues.modeId === "string" && initialValues.modeId.length > 0) {
      userEditedPreferencesRef.current.mode = true;
      setSelectedMode(initialValues.modeId);
    }

    if (typeof initialValues.model === "string" && initialValues.model.length > 0) {
      userEditedPreferencesRef.current.model = true;
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

  useEffect(() => {
    let isActive = true;
    const hydratePreferences = async () => {
      try {
        const stored = await AsyncStorage.getItem(FORM_PREFERENCES_STORAGE_KEY);
        if (!stored || !isActive) {
          return;
        }
        const parsed = JSON.parse(stored) as {
          workingDir?: string;
          provider?: AgentProvider;
          mode?: string;
          model?: string;
          serverId?: string;
        };
        if (
          parsed.provider &&
          providerDefinitionMap.has(parsed.provider) &&
          !userEditedPreferencesRef.current.provider
        ) {
          setSelectedProvider(parsed.provider);
        }
        if (typeof parsed.mode === "string" && !userEditedPreferencesRef.current.mode) {
          setSelectedMode(parsed.mode);
        }
        if (
          typeof parsed.workingDir === "string" &&
          !userEditedPreferencesRef.current.workingDir
        ) {
          setWorkingDir(parsed.workingDir);
        }
        if (typeof parsed.model === "string" && !userEditedPreferencesRef.current.model) {
          setSelectedModel(parsed.model);
        }
        if (
          typeof parsed.serverId === "string" &&
          !userEditedPreferencesRef.current.serverId
        ) {
          setSelectedServerId(parsed.serverId);
        }
      } catch (error) {
        console.error(
          "[useAgentFormState] Failed to hydrate form preferences:",
          error
        );
      } finally {
        if (isActive) {
          formPreferencesHydratedRef.current = true;
        }
      }
    };
    void hydratePreferences();
    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    if (!formPreferencesHydratedRef.current) {
      return;
    }
    const persist = async () => {
      const nextPayload: {
        workingDir?: string;
        provider?: AgentProvider;
        mode?: string;
        model?: string;
        serverId?: string;
      } = {};
      if (userEditedPreferencesRef.current.workingDir) {
        nextPayload.workingDir = workingDir;
      }
      if (userEditedPreferencesRef.current.provider) {
        nextPayload.provider = selectedProvider;
      }
      if (userEditedPreferencesRef.current.mode) {
        nextPayload.mode = selectedMode;
      }
      if (userEditedPreferencesRef.current.model) {
        nextPayload.model = selectedModel;
      }
      if (userEditedPreferencesRef.current.serverId) {
        nextPayload.serverId = selectedServerId ?? undefined;
      }
      if (Object.keys(nextPayload).length === 0) {
        return;
      }
      try {
        const stored = await AsyncStorage.getItem(FORM_PREFERENCES_STORAGE_KEY);
        const parsed = stored
          ? (JSON.parse(stored) as Record<string, unknown>)
          : {};
        await AsyncStorage.setItem(
          FORM_PREFERENCES_STORAGE_KEY,
          JSON.stringify({
            ...parsed,
            ...nextPayload,
          })
        );
      } catch (error) {
        console.error(
          "[useAgentFormState] Failed to persist form preferences:",
          error
        );
      }
    };
    void persist();
  }, [selectedMode, selectedProvider, workingDir, selectedModel, selectedServerId]);

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
      if (!sessionState?.ws?.isConnected) {
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

        const requestId = generateMessageId();
        const message: WSInboundMessage = {
          type: "session",
          message: {
            type: "list_provider_models_request",
            provider: selectedProvider,
            ...(options?.cwd ? { cwd: options.cwd } : {}),
            requestId,
          },
        };
        sessionState.ws?.send(message);
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
      userEditedPreferencesRef,
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
      workingDir,
      workingDirIsEmpty,
    ]
  );
}
