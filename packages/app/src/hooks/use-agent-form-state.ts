import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentProviderDefinition } from "@server/server/agent/provider-manifest";
import type {
  AgentMode,
  AgentModelDefinition,
  AgentProvider,
  ProviderSnapshotEntry,
} from "@server/server/agent/agent-sdk-types";
import { useHosts } from "@/runtime/host-runtime";
import { buildProviderDefinitions } from "@/utils/provider-definitions";
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
  provider: AgentProvider | null;
  modeId: string;
  model: string;
  thinkingOptionId: string;
  workingDir: string;
}

interface UseAgentFormStateOptions {
  initialServerId?: string | null;
  initialValues?: FormInitialValues;
  isVisible?: boolean;
  isCreateFlow?: boolean;
  isTargetDaemonReady?: boolean;
  onlineServerIds?: string[];
}

export interface UseAgentFormStateResult {
  selectedServerId: string | null;
  setSelectedServerId: (value: string | null) => void;
  setSelectedServerIdFromUser: (value: string | null) => void;
  selectedProvider: AgentProvider | null;
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
  refetchProviderModelsIfStale: () => void;
  setProviderAndModelFromUser: (provider: AgentProvider, modelId: string) => void;
  workingDirIsEmpty: boolean;
  persistFormPreferences: () => Promise<void>;
}

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
    return null;
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

function mergeSelectedComposerPreferences(args: {
  preferences: FormPreferences;
  provider: AgentProvider;
  updates: Partial<ProviderPreferences>;
}): FormPreferences {
  return mergeProviderPreferences({
    preferences: args.preferences,
    provider: args.provider,
    updates: args.updates,
  });
}

/**
 * Pure function that resolves form state from multiple data sources.
 * Priority: explicit (URL params) > provider defaults > lightweight app prefs > fallback
 *
 * Only resolves fields that haven't been user-modified.
 */
function resolveProvider(input: {
  currentProvider: AgentProvider | null;
  userModified: boolean;
  initialValues: FormInitialValues | undefined;
  preferences: FormPreferences | null;
  allowedProviderMap: Map<AgentProvider, AgentProviderDefinition>;
}): AgentProvider | null {
  const { currentProvider, userModified, initialValues, preferences, allowedProviderMap } = input;
  if (userModified) {
    if (
      currentProvider &&
      allowedProviderMap.size > 0 &&
      !allowedProviderMap.has(currentProvider)
    ) {
      return null;
    }
    return currentProvider;
  }
  if (initialValues?.provider && allowedProviderMap.has(initialValues.provider)) {
    return initialValues.provider;
  }
  if (preferences?.provider && allowedProviderMap.has(preferences.provider as AgentProvider)) {
    return preferences.provider as AgentProvider;
  }
  if (currentProvider && allowedProviderMap.size > 0 && !allowedProviderMap.has(currentProvider)) {
    return null;
  }
  return currentProvider;
}

function resolveModeId(input: {
  provider: AgentProvider | null;
  userModified: boolean;
  currentModeId: string;
  initialValues: FormInitialValues | undefined;
  providerDef: AgentProviderDefinition | undefined;
  providerPrefs: NonNullable<FormPreferences["providerPreferences"]>[AgentProvider] | undefined;
}): string {
  const { provider, userModified, currentModeId, initialValues, providerDef, providerPrefs } =
    input;
  if (userModified) return currentModeId;
  if (!provider) return "";
  const validModeIds = providerDef?.modes.map((m) => m.id) ?? [];
  if (
    typeof initialValues?.modeId === "string" &&
    initialValues.modeId.length > 0 &&
    validModeIds.includes(initialValues.modeId)
  ) {
    return initialValues.modeId;
  }
  if (providerPrefs?.mode && validModeIds.includes(providerPrefs.mode)) {
    return providerPrefs.mode;
  }
  return providerDef?.defaultModeId ?? validModeIds[0] ?? "";
}

function resolveModelField(input: {
  provider: AgentProvider | null;
  userModified: boolean;
  currentModel: string;
  initialValues: FormInitialValues | undefined;
  providerPrefs: NonNullable<FormPreferences["providerPreferences"]>[AgentProvider] | undefined;
  availableModels: AgentModelDefinition[] | null;
}): string {
  const { provider, userModified, currentModel, initialValues, providerPrefs, availableModels } =
    input;
  if (userModified) return currentModel;
  if (!provider) return "";
  const isValidModel = (m: string) => availableModels?.some((am) => am.id === m) ?? false;
  const initialModel = normalizeSelectedModelId(initialValues?.model);
  const preferredModel = normalizeSelectedModelId(providerPrefs?.model);
  const defaultModelId = resolveDefaultModelId(availableModels);
  if (initialModel) {
    return !availableModels || isValidModel(initialModel) ? initialModel : defaultModelId;
  }
  if (preferredModel) {
    return !availableModels || isValidModel(preferredModel) ? preferredModel : defaultModelId;
  }
  return "";
}

function resolveThinkingOption(input: {
  provider: AgentProvider | null;
  userModified: boolean;
  currentThinkingOptionId: string;
  modelId: string;
  initialValues: FormInitialValues | undefined;
  providerPrefs: NonNullable<FormPreferences["providerPreferences"]>[AgentProvider] | undefined;
}): string {
  const { provider, userModified, currentThinkingOptionId, modelId, initialValues, providerPrefs } =
    input;
  if (!provider) return "";
  if (userModified) return currentThinkingOptionId;
  const initialThinkingOptionId =
    typeof initialValues?.thinkingOptionId === "string"
      ? initialValues.thinkingOptionId.trim()
      : "";
  const effectiveModelId = modelId.trim();
  const preferredThinking = effectiveModelId
    ? (providerPrefs?.thinkingByModel?.[effectiveModelId]?.trim() ?? "")
    : "";
  if (initialThinkingOptionId.length > 0) return initialThinkingOptionId;
  if (preferredThinking.length > 0) return preferredThinking;
  return "";
}

function resolveFormState(
  initialValues: FormInitialValues | undefined,
  preferences: FormPreferences | null,
  availableModels: AgentModelDefinition[] | null,
  userModified: UserModifiedFields,
  currentState: FormState,
  validServerIds: Set<string>,
  allowedProviderMap: Map<AgentProvider, AgentProviderDefinition>,
): FormState {
  const result = { ...currentState };

  result.provider = resolveProvider({
    currentProvider: result.provider,
    userModified: userModified.provider,
    initialValues,
    preferences,
    allowedProviderMap,
  });

  const providerDef = result.provider ? allowedProviderMap.get(result.provider) : undefined;
  const providerPrefs = result.provider
    ? preferences?.providerPreferences?.[result.provider]
    : undefined;

  result.modeId = resolveModeId({
    provider: result.provider,
    userModified: userModified.modeId,
    currentModeId: result.modeId,
    initialValues,
    providerDef,
    providerPrefs,
  });

  result.model = resolveModelField({
    provider: result.provider,
    userModified: userModified.model,
    currentModel: result.model,
    initialValues,
    providerPrefs,
    availableModels,
  });

  result.thinkingOptionId = resolveThinkingOption({
    provider: result.provider,
    userModified: userModified.thinkingOptionId,
    currentThinkingOptionId: result.thinkingOptionId,
    modelId: result.model,
    initialValues,
    providerPrefs,
  });

  if (result.provider && availableModels) {
    result.thinkingOptionId = resolveThinkingOptionId({
      availableModels,
      modelId: result.model,
      requestedThinkingOptionId: result.thinkingOptionId,
    });
  }

  if (!userModified.serverId && initialValues?.serverId !== undefined) {
    result.serverId = initialValues.serverId;
  }

  if (!userModified.workingDir && initialValues?.workingDir !== undefined) {
    result.workingDir = initialValues.workingDir;
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

const RESOLVABLE_PROVIDER_STATUSES = new Set<ProviderSnapshotEntry["status"]>(["ready", "loading"]);
const SELECTABLE_PROVIDER_STATUSES = new Set<ProviderSnapshotEntry["status"]>(["ready"]);

function buildProviderDefinitionMap(
  providerDefinitions: AgentProviderDefinition[],
): Map<AgentProvider, AgentProviderDefinition> {
  return new Map<AgentProvider, AgentProviderDefinition>(
    providerDefinitions.map((definition) => [definition.id, definition]),
  );
}

function buildProviderDefinitionMapForStatuses(args: {
  snapshotEntries: ProviderSnapshotEntry[] | undefined;
  providerDefinitions: AgentProviderDefinition[];
  statuses: ReadonlySet<ProviderSnapshotEntry["status"]>;
}): Map<AgentProvider, AgentProviderDefinition> {
  if (!args.snapshotEntries?.length) {
    return buildProviderDefinitionMap(args.providerDefinitions);
  }

  const matchingProviders = new Set(
    args.snapshotEntries
      .filter((entry) => args.statuses.has(entry.status) && entry.enabled !== false)
      .map((entry) => entry.provider),
  );

  return buildProviderDefinitionMap(
    args.providerDefinitions.filter((definition) => matchingProviders.has(definition.id)),
  );
}

type ProviderPrefs = NonNullable<FormPreferences["providerPreferences"]>[AgentProvider];

function shouldAutoSelectServerId(input: {
  isVisible: boolean;
  isCreateFlow: boolean;
  isPreferencesLoading: boolean;
  hasResolved: boolean;
  userModifiedServerId: boolean;
  initialServerId: string | null | undefined;
  currentServerId: string | null;
}): boolean {
  const {
    isVisible,
    isCreateFlow,
    isPreferencesLoading,
    hasResolved,
    userModifiedServerId,
    initialServerId,
    currentServerId,
  } = input;
  if (!isVisible || !isCreateFlow) return false;
  if (isPreferencesLoading) return false;
  if (!hasResolved) return false;
  if (userModifiedServerId) return false;
  if (initialServerId !== undefined) return false;
  if (currentServerId) return false;
  return true;
}

function hasFormStateChanged(prev: FormState, next: FormState): boolean {
  return (
    prev.serverId !== next.serverId ||
    prev.provider !== next.provider ||
    prev.modeId !== next.modeId ||
    prev.model !== next.model ||
    prev.thinkingOptionId !== next.thinkingOptionId ||
    prev.workingDir !== next.workingDir
  );
}

function pickNextModelForProvider(input: {
  providerModels: AgentModelDefinition[] | null;
  providerPrefs: ProviderPrefs | undefined;
}): string {
  const { providerModels, providerPrefs } = input;
  const isValidModel = (m: string) => providerModels?.some((am) => am.id === m) ?? false;
  const preferredModel = normalizeSelectedModelId(providerPrefs?.model);
  const defaultModelId = resolveDefaultModelId(providerModels);
  if (preferredModel && (!providerModels || isValidModel(preferredModel))) {
    return preferredModel;
  }
  return defaultModelId;
}

function pickNextModeForProvider(input: {
  providerDef: AgentProviderDefinition | undefined;
  providerPrefs: ProviderPrefs | undefined;
}): string {
  const { providerDef, providerPrefs } = input;
  const validModeIds = providerDef?.modes.map((m) => m.id) ?? [];
  if (providerPrefs?.mode && validModeIds.includes(providerPrefs.mode)) {
    return providerPrefs.mode;
  }
  return providerDef?.defaultModeId ?? "";
}

function pickNextThinkingOptionForProvider(input: {
  providerModels: AgentModelDefinition[] | null;
  providerPrefs: ProviderPrefs | undefined;
  modelId: string;
}): string {
  const { providerModels, providerPrefs, modelId } = input;
  const preferredThinking = modelId
    ? (providerPrefs?.thinkingByModel?.[modelId]?.trim() ?? "")
    : "";
  return resolveThinkingOptionId({
    availableModels: providerModels,
    modelId,
    requestedThinkingOptionId: preferredThinking,
  });
}

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
    map.set(entry.provider, entry.models ?? []);
  }
  return map;
}

async function persistProviderPreferences(input: {
  provider: AgentProvider;
  formState: FormState;
  availableModels: AgentModelDefinition[] | null;
  updatePreferences: (
    updates: Partial<FormPreferences> | ((current: FormPreferences) => FormPreferences),
  ) => Promise<void>;
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

export function useAgentFormState(options: UseAgentFormStateOptions = {}): UseAgentFormStateResult {
  const {
    initialServerId = null,
    initialValues,
    isVisible = true,
    isCreateFlow = true,
    isTargetDaemonReady: _isTargetDaemonReady = true,
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
    provider: null,
    modeId: "",
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
  const hydrationPreferencesRef = useRef<FormPreferences | null>(null);

  // Reset user modifications when form becomes invisible
  useEffect(() => {
    if (!isVisible) {
      setUserModified(INITIAL_USER_MODIFIED);
      hasResolvedRef.current = false;
      hydrationPreferencesRef.current = null;
    }
  }, [isVisible]);

  const {
    entries: snapshotEntries,
    isLoading: snapshotIsLoading,
    error: snapshotError,
    refresh: refreshSnapshot,
    refetchIfStale: refetchSnapshotIfStale,
  } = useProvidersSnapshot(formState.serverId);

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
  const snapshotSelectedEntry = useMemo(
    () =>
      formState.provider
        ? ((snapshotEntries ?? []).find((entry) => entry.provider === formState.provider) ?? null)
        : null,
    [formState.provider, snapshotEntries],
  );
  const snapshotSelectedProviderModels = snapshotSelectedEntry?.models ?? null;
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
  const availableModels = snapshotSelectedProviderModels;
  const modeOptions = snapshotSelectedProviderModes;
  const isAllModelsLoading = snapshotIsLoading || selectedProviderIsLoading;

  // Combine initialValues with initialServerId for resolution
  const combinedInitialValues = useMemo((): FormInitialValues | undefined => {
    return combineInitialValues(initialValues, initialServerId);
  }, [initialValues, initialServerId]);

  // Resolve form state when data sources change
  useEffect(() => {
    if (!isVisible || !isCreateFlow) {
      return;
    }

    if (isPreferencesLoading && !hasResolvedRef.current) {
      return;
    }

    if (!hasResolvedRef.current) {
      hydrationPreferencesRef.current = preferences;
    }
    const hydrationPreferences = hydrationPreferencesRef.current ?? preferences;

    const resolved = resolveFormState(
      combinedInitialValues,
      hydrationPreferences,
      availableModels,
      userModified,
      formStateRef.current,
      validServerIds,
      snapshotResolvableProviderDefinitionMap,
    );

    if (hasFormStateChanged(formStateRef.current, resolved)) {
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
    snapshotResolvableProviderDefinitionMap,
  ]);

  // Auto-select the first online host when:
  // - no URL override
  // - no stored preference applied
  // - user hasn't manually picked a host in this session
  const onlineServerIdsKey = onlineServerIds.join("|");
  useEffect(() => {
    const canAutoSelectServerId = shouldAutoSelectServerId({
      isVisible,
      isCreateFlow,
      isPreferencesLoading,
      hasResolved: hasResolvedRef.current,
      userModifiedServerId: userModified.serverId,
      initialServerId: combinedInitialValues?.serverId,
      currentServerId: formStateRef.current.serverId,
    });
    if (!canAutoSelectServerId) return;

    const candidate = onlineServerIds.find((id) => validServerIds.has(id)) ?? null;
    if (!candidate) return;

    setFormState((prev) => (prev.serverId ? prev : { ...prev, serverId: candidate }));
  }, [
    combinedInitialValues?.serverId,
    isCreateFlow,
    isPreferencesLoading,
    isVisible,
    onlineServerIds,
    onlineServerIdsKey,
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

      const nextModelId = pickNextModelForProvider({ providerModels, providerPrefs });
      const nextModeId = pickNextModeForProvider({ providerDef, providerPrefs });
      const nextThinkingOptionId = pickNextThinkingOptionForProvider({
        providerModels,
        providerPrefs,
        modelId: nextModelId,
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
      void updatePreferences((current) =>
        mergeSelectedComposerPreferences({
          preferences: current,
          provider,
          updates: {
            model: nextModelId || undefined,
          },
        }),
      );
    },
    [allProviderModels, selectableProviderDefinitionMap, updatePreferences],
  );

  const setModeFromUser = useCallback(
    (modeId: string) => {
      setFormState((prev) => ({ ...prev, modeId }));
      setUserModified((prev) => ({ ...prev, modeId: true }));
      const provider = formStateRef.current.provider;
      if (provider) {
        void updatePreferences((current) =>
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
    [updatePreferences],
  );

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
      const provider = formStateRef.current.provider;
      if (provider) {
        void updatePreferences((current) =>
          mergeSelectedComposerPreferences({
            preferences: current,
            provider,
            updates: {
              model: nextModelId || undefined,
            },
          }),
        );
      }
    },
    [availableModels, updatePreferences, userModified.thinkingOptionId],
  );

  const setThinkingOptionFromUser = useCallback(
    (thinkingOptionId: string) => {
      setFormState((prev) => ({ ...prev, thinkingOptionId }));
      setUserModified((prev) => ({ ...prev, thinkingOptionId: true }));
      const provider = formStateRef.current.provider;
      const modelId = formStateRef.current.model;
      if (provider && modelId) {
        void updatePreferences((current) =>
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
    [updatePreferences],
  );

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

  const refetchProviderModelsIfStale = useCallback(() => {
    refetchSnapshotIfStale(formStateRef.current.provider);
  }, [refetchSnapshotIfStale]);

  const persistFormPreferences = useCallback(async () => {
    if (!formState.provider) {
      return;
    }
    await persistProviderPreferences({
      provider: formState.provider,
      formState,
      availableModels,
      updatePreferences,
    });
  }, [availableModels, formState, updatePreferences]);

  const agentDefinition = formState.provider
    ? providerDefinitionMap.get(formState.provider)
    : undefined;
  const effectiveModel = resolveEffectiveModel(availableModels, formState.model);
  const resolvedModelId = effectiveModel?.id ?? formState.model;
  const availableThinkingOptionsRaw = effectiveModel?.thinkingOptions;
  const availableThinkingOptions = useMemo(
    () => availableThinkingOptionsRaw ?? [],
    [availableThinkingOptionsRaw],
  );
  const isModelLoading = snapshotIsLoading || selectedProviderIsLoading;
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
      refetchProviderModelsIfStale,
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
      refetchProviderModelsIfStale,
      setProviderAndModelFromUser,
      workingDirIsEmpty,
      persistFormPreferences,
    ],
  );
}

// Re-export for backwards compatibility
export type CreateAgentInitialValues = FormInitialValues;

export const __private__ = {
  buildProviderDefinitionMap,
  buildProviderDefinitionMapForStatuses,
  combineInitialValues,
  mergeSelectedComposerPreferences,
  resolveDefaultModel,
  resolveFormState,
  resolveThinkingOptionId,
};
