import type { AgentProviderDefinition } from "@server/server/agent/provider-manifest";
import type {
  AgentModelDefinition,
  AgentProvider,
  ProviderSnapshotEntry,
} from "@server/server/agent/agent-sdk-types";
import {
  mergeProviderPreferences,
  type FormPreferences,
  type ProviderPreferences,
} from "./use-form-preferences";

export interface FormInitialValues {
  serverId?: string | null;
  provider?: AgentProvider;
  modeId?: string | null;
  model?: string | null;
  thinkingOptionId?: string | null;
  workingDir?: string;
}

export interface FormState {
  serverId: string | null;
  provider: AgentProvider | null;
  modeId: string;
  model: string;
  thinkingOptionId: string;
  workingDir: string;
}

export interface UserModifiedFields {
  serverId: boolean;
  provider: boolean;
  modeId: boolean;
  model: boolean;
  thinkingOptionId: boolean;
  workingDir: boolean;
}

export interface AgentFormReducerState {
  form: FormState;
  userModified: UserModifiedFields;
}

export const INITIAL_USER_MODIFIED: UserModifiedFields = {
  serverId: false,
  provider: false,
  modeId: false,
  model: false,
  thinkingOptionId: false,
  workingDir: false,
};

type ProviderPrefs = NonNullable<FormPreferences["providerPreferences"]>[AgentProvider];

export const RESOLVABLE_PROVIDER_STATUSES = new Set<ProviderSnapshotEntry["status"]>([
  "ready",
  "loading",
]);
export const SELECTABLE_PROVIDER_STATUSES = new Set<ProviderSnapshotEntry["status"]>(["ready"]);

export type AgentFormAction =
  | {
      type: "RESOLVE";
      initialValues: FormInitialValues | undefined;
      preferences: FormPreferences | null;
      availableModels: AgentModelDefinition[] | null;
      allowedProviderMap: Map<AgentProvider, AgentProviderDefinition>;
    }
  | { type: "SET_SERVER_ID"; value: string | null }
  | { type: "SET_SERVER_ID_FROM_USER"; value: string | null }
  | {
      type: "SET_PROVIDER_FROM_USER";
      provider: AgentProvider;
      providerModels: AgentModelDefinition[] | null;
      providerDef: AgentProviderDefinition | undefined;
      providerPrefs: ProviderPrefs | undefined;
    }
  | {
      type: "SET_PROVIDER_AND_MODEL_FROM_USER";
      provider: AgentProvider;
      modelId: string;
      providerDef: AgentProviderDefinition | undefined;
      providerModels: AgentModelDefinition[] | null;
    }
  | { type: "SET_MODE_FROM_USER"; modeId: string }
  | {
      type: "SET_MODEL_FROM_USER";
      modelId: string;
      availableModels: AgentModelDefinition[] | null;
    }
  | { type: "SET_THINKING_OPTION_FROM_USER"; thinkingOptionId: string }
  | { type: "SET_WORKING_DIR"; value: string }
  | { type: "SET_WORKING_DIR_FROM_USER"; value: string }
  | { type: "AUTO_SELECT_SERVER"; candidateServerId: string }
  | { type: "RESET" };

export function normalizeSelectedModelId(modelId: string | null | undefined): string {
  return typeof modelId === "string" ? modelId.trim() : "";
}

export function resolveDefaultModel(
  availableModels: AgentModelDefinition[] | null,
): AgentModelDefinition | null {
  if (!availableModels || availableModels.length === 0) return null;
  return availableModels.find((model) => model.isDefault) ?? availableModels[0] ?? null;
}

export function resolveDefaultModelId(availableModels: AgentModelDefinition[] | null): string {
  return resolveDefaultModel(availableModels)?.id ?? "";
}

export function resolveEffectiveModel(
  availableModels: AgentModelDefinition[] | null,
  modelId: string,
): AgentModelDefinition | null {
  if (!availableModels || availableModels.length === 0) return null;
  const normalizedModelId = modelId.trim();
  if (!normalizedModelId) return null;
  return (
    availableModels.find((model) => model.id === normalizedModelId) ??
    resolveDefaultModel(availableModels)
  );
}

export function resolveThinkingOptionId(args: {
  availableModels: AgentModelDefinition[] | null;
  modelId: string;
  requestedThinkingOptionId: string;
}): string {
  const effectiveModel = resolveEffectiveModel(args.availableModels, args.modelId);
  const thinkingOptions = effectiveModel?.thinkingOptions ?? [];
  if (thinkingOptions.length === 0) return "";

  const normalizedThinkingOptionId = args.requestedThinkingOptionId.trim();
  if (
    normalizedThinkingOptionId &&
    thinkingOptions.some((option) => option.id === normalizedThinkingOptionId)
  ) {
    return normalizedThinkingOptionId;
  }

  return effectiveModel?.defaultThinkingOptionId ?? thinkingOptions[0]?.id ?? "";
}

export function mergeSelectedComposerPreferences(args: {
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

export function combineInitialValues(
  initialValues: FormInitialValues | undefined,
  initialServerId: string | null,
): FormInitialValues | undefined {
  const hasExplicitServerId = initialValues?.serverId !== undefined;
  const serverIdFromOptions = initialServerId === null ? undefined : initialServerId;

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

export function hasFormStateChanged(prev: FormState, next: FormState): boolean {
  return (
    prev.serverId !== next.serverId ||
    prev.provider !== next.provider ||
    prev.modeId !== next.modeId ||
    prev.model !== next.model ||
    prev.thinkingOptionId !== next.thinkingOptionId ||
    prev.workingDir !== next.workingDir
  );
}

export function buildProviderDefinitionMap(
  providerDefinitions: AgentProviderDefinition[],
): Map<AgentProvider, AgentProviderDefinition> {
  return new Map<AgentProvider, AgentProviderDefinition>(
    providerDefinitions.map((definition) => [definition.id, definition]),
  );
}

export function buildProviderDefinitionMapForStatuses(args: {
  snapshotEntries: ProviderSnapshotEntry[] | undefined;
  providerDefinitions: AgentProviderDefinition[];
  statuses: ReadonlySet<ProviderSnapshotEntry["status"]>;
}): Map<AgentProvider, AgentProviderDefinition> {
  if (!args.snapshotEntries?.length) {
    return buildProviderDefinitionMap(args.providerDefinitions);
  }

  const matchingProviders = new Set(
    args.snapshotEntries
      .filter((entry) => args.statuses.has(entry.status) && entry.enabled)
      .map((entry) => entry.provider),
  );

  return buildProviderDefinitionMap(
    args.providerDefinitions.filter((definition) => matchingProviders.has(definition.id)),
  );
}

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
  if (preferences?.provider && allowedProviderMap.has(preferences.provider)) {
    return preferences.provider;
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
  providerPrefs: ProviderPrefs | undefined;
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
  providerPrefs: ProviderPrefs | undefined;
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
  providerPrefs: ProviderPrefs | undefined;
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

export function resolveFormState(
  initialValues: FormInitialValues | undefined,
  preferences: FormPreferences | null,
  availableModels: AgentModelDefinition[] | null,
  userModified: UserModifiedFields,
  currentState: FormState,
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

export function resolveAgentForm(
  state: AgentFormReducerState,
  action: AgentFormAction,
): AgentFormReducerState {
  switch (action.type) {
    case "RESOLVE": {
      const resolved = resolveFormState(
        action.initialValues,
        action.preferences,
        action.availableModels,
        state.userModified,
        state.form,
        action.allowedProviderMap,
      );
      if (!hasFormStateChanged(state.form, resolved)) return state;
      return { ...state, form: resolved };
    }

    case "SET_SERVER_ID":
      return { ...state, form: { ...state.form, serverId: action.value } };

    case "SET_SERVER_ID_FROM_USER":
      return {
        form: { ...state.form, serverId: action.value },
        userModified: { ...state.userModified, serverId: true },
      };

    case "SET_PROVIDER_FROM_USER": {
      const nextModelId = pickNextModelForProvider({
        providerModels: action.providerModels,
        providerPrefs: action.providerPrefs,
      });
      const nextModeId = pickNextModeForProvider({
        providerDef: action.providerDef,
        providerPrefs: action.providerPrefs,
      });
      const nextThinkingOptionId = pickNextThinkingOptionForProvider({
        providerModels: action.providerModels,
        providerPrefs: action.providerPrefs,
        modelId: nextModelId,
      });
      return {
        form: {
          ...state.form,
          provider: action.provider,
          modeId: nextModeId,
          model: nextModelId,
          thinkingOptionId: nextThinkingOptionId,
        },
        userModified: { ...state.userModified, provider: true },
      };
    }

    case "SET_PROVIDER_AND_MODEL_FROM_USER": {
      const normalizedModelId = normalizeSelectedModelId(action.modelId);
      const nextModelId = normalizedModelId || resolveDefaultModelId(action.providerModels);
      const nextThinkingOptionId = resolveThinkingOptionId({
        availableModels: action.providerModels,
        modelId: nextModelId,
        requestedThinkingOptionId: "",
      });
      return {
        form: {
          ...state.form,
          provider: action.provider,
          model: nextModelId,
          modeId: action.providerDef?.defaultModeId ?? "",
          thinkingOptionId: nextThinkingOptionId,
        },
        userModified: { ...state.userModified, provider: true, model: true },
      };
    }

    case "SET_MODE_FROM_USER":
      return {
        form: { ...state.form, modeId: action.modeId },
        userModified: { ...state.userModified, modeId: true },
      };

    case "SET_MODEL_FROM_USER": {
      const normalizedModelId = normalizeSelectedModelId(action.modelId);
      const nextModelId = normalizedModelId || resolveDefaultModelId(action.availableModels);
      const nextThinkingOptionId = resolveThinkingOptionId({
        availableModels: action.availableModels,
        modelId: nextModelId,
        requestedThinkingOptionId: state.userModified.thinkingOptionId
          ? state.form.thinkingOptionId
          : "",
      });
      return {
        form: {
          ...state.form,
          model: nextModelId,
          thinkingOptionId: nextThinkingOptionId,
        },
        userModified: { ...state.userModified, model: true },
      };
    }

    case "SET_THINKING_OPTION_FROM_USER":
      return {
        form: { ...state.form, thinkingOptionId: action.thinkingOptionId },
        userModified: { ...state.userModified, thinkingOptionId: true },
      };

    case "SET_WORKING_DIR":
      return { ...state, form: { ...state.form, workingDir: action.value } };

    case "SET_WORKING_DIR_FROM_USER":
      return {
        form: { ...state.form, workingDir: action.value },
        userModified: { ...state.userModified, workingDir: true },
      };

    case "AUTO_SELECT_SERVER":
      if (state.form.serverId) return state;
      return { ...state, form: { ...state.form, serverId: action.candidateServerId } };

    case "RESET":
      return { ...state, userModified: INITIAL_USER_MODIFIED };
  }
}
