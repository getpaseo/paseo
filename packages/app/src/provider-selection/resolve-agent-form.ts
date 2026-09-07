import type { AgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";
import type {
  AgentModelDefinition,
  AgentProvider,
  ProviderSnapshotEntry,
} from "@getpaseo/protocol/agent-types";
import {
  mergeProviderPreferences,
  type FormPreferences,
  type ProviderPreferences,
} from "@/hooks/use-form-preferences";
import { findModelByReference } from "./model-catalog";

export interface FormInitialValues {
  provider?: AgentProvider;
  modeId?: string | null;
  model?: string | null;
  thinkingOptionId?: string | null;
}

export interface FormState {
  provider: AgentProvider | null;
  modeId: string;
  model: string;
  thinkingOptionId: string;
}

export interface UserModifiedFields {
  provider: boolean;
  modeId: boolean;
  model: boolean;
  thinkingOptionId: boolean;
}

export type ProviderModelsByProvider = Map<AgentProvider, AgentModelDefinition[] | null>;

export type AgentFormResolutionState = { status: "pending" } | { status: "completed" };

export interface AgentFormReducerState {
  form: FormState;
  userModified: UserModifiedFields;
  resolution: AgentFormResolutionState;
  inputs?: {
    serverId: string | null;
    initialValues: FormInitialValues | undefined;
    active: boolean;
  };
}

export const INITIAL_USER_MODIFIED: UserModifiedFields = {
  provider: false,
  modeId: false,
  model: false,
  thinkingOptionId: false,
};

export const PENDING_AGENT_FORM_RESOLUTION: AgentFormResolutionState = { status: "pending" };
export const INITIAL_AGENT_FORM_RESOLUTION = PENDING_AGENT_FORM_RESOLUTION;

type ProviderPrefs = NonNullable<FormPreferences["providerPreferences"]>[AgentProvider];

export const RESOLVABLE_PROVIDER_STATUSES = new Set<ProviderSnapshotEntry["status"]>([
  "ready",
  "loading",
]);
export const SELECTABLE_PROVIDER_STATUSES = new Set<ProviderSnapshotEntry["status"]>(["ready"]);

interface AgentFormInputs {
  type: "INPUTS_CHANGED";
  serverId: string | null;
  isVisible: boolean;
  isCreateFlow: boolean;
  isPreferencesLoading: boolean;
  hasSnapshot: boolean;
  initialValues: FormInitialValues | undefined;
  preferences: FormPreferences | null;
  providerModelsByProvider: ProviderModelsByProvider;
  allowedProviderMap: Map<AgentProvider, AgentProviderDefinition>;
}

export type AgentFormAction =
  | AgentFormInputs
  | { type: "REQUEST_RESOLUTION" }
  | {
      type: "COMPLETE_RESOLUTION";
      initialValues: FormInitialValues | undefined;
      preferences: FormPreferences | null;
      providerModelsByProvider: ProviderModelsByProvider;
      allowedProviderMap: Map<AgentProvider, AgentProviderDefinition>;
    }
  | {
      type: "SET_PROVIDER_AND_MODEL_FROM_USER";
      provider: AgentProvider;
      modelId: string;
      providerDef: AgentProviderDefinition | undefined;
      providerModels: AgentModelDefinition[] | null;
      providerPrefs?: ProviderPrefs | undefined;
    }
  | {
      type: "APPLY_PROFILE_FROM_USER";
      provider: AgentProvider;
      modelId: string;
      modeId: string;
      thinkingOptionId: string;
      providerDef: AgentProviderDefinition | undefined;
      providerModels: AgentModelDefinition[] | null;
      providerPrefs?: ProviderPrefs | undefined;
    }
  | { type: "SET_MODE_FROM_USER"; modeId: string }
  | {
      type: "SET_MODEL_FROM_USER";
      modelId: string;
      availableModels: AgentModelDefinition[] | null;
      providerPrefs: ProviderPrefs | undefined;
    }
  | { type: "CLEAR_PROVIDER_SELECTION_FROM_USER" }
  | { type: "SET_THINKING_OPTION_FROM_USER"; thinkingOptionId: string }
  | { type: "RESET" };

type CompleteResolutionAction = Extract<AgentFormAction, { type: "COMPLETE_RESOLUTION" }>;
type ApplyProfileAction = Extract<AgentFormAction, { type: "APPLY_PROFILE_FROM_USER" }>;

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

function resolveCanonicalModelId(
  availableModels: AgentModelDefinition[] | null,
  modelId: string,
): string {
  const normalizedModelId = normalizeSelectedModelId(modelId);
  if (!normalizedModelId || !availableModels) return normalizedModelId;
  return findModelByReference(availableModels, normalizedModelId)?.id ?? "";
}

export function resolveEffectiveModel(
  availableModels: AgentModelDefinition[] | null,
  modelId: string,
): AgentModelDefinition | null {
  if (!availableModels || availableModels.length === 0) return null;
  if (!normalizeSelectedModelId(modelId)) return null;
  return findModelByReference(availableModels, modelId) ?? null;
}

function resolvePreferredThinkingOptionId(input: {
  availableModels: AgentModelDefinition[] | null;
  providerPrefs: ProviderPrefs | undefined;
  modelId: string;
}): string {
  const model = findModelByReference(input.availableModels, input.modelId);
  const modelReferences = model ? [model.id, ...(model.aliases ?? [])] : [input.modelId];
  for (const modelReference of modelReferences) {
    const thinkingOptionId = input.providerPrefs?.thinkingByModel?.[modelReference]?.trim();
    if (thinkingOptionId) return thinkingOptionId;
  }
  return "";
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

const normalizeSelectedModeId = normalizeSelectedModelId;

function resolvePreferredModeId(input: {
  initialModeId?: string | null;
  preferredModeId?: string | null;
  providerDef: AgentProviderDefinition | undefined;
}): string {
  // Saved modes are user intent. Provider create config validates unknown modes
  // at submission time, so background form resolution should not erase them.
  const initialModeId = normalizeSelectedModeId(input.initialModeId);
  if (initialModeId) return initialModeId;

  const preferredModeId = normalizeSelectedModeId(input.preferredModeId);
  if (preferredModeId) return preferredModeId;

  const defaultModeId = input.providerDef?.defaultModeId;
  const modes = input.providerDef?.modes ?? [];
  if (defaultModeId && (modes.length === 0 || modes.some((mode) => mode.id === defaultModeId))) {
    return defaultModeId;
  }
  return modes[0]?.id ?? "";
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

export function hasFormStateChanged(prev: FormState, next: FormState): boolean {
  return (
    prev.provider !== next.provider ||
    prev.modeId !== next.modeId ||
    prev.model !== next.model ||
    prev.thinkingOptionId !== next.thinkingOptionId
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
}): AgentProvider | null {
  const { currentProvider, userModified, initialValues, preferences } = input;
  // Discovery readiness does not change the user's saved or explicit choice.
  if (userModified) return currentProvider;
  return initialValues?.provider ?? preferences?.provider ?? currentProvider;
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
  return resolvePreferredModeId({
    initialModeId: initialValues?.modeId,
    preferredModeId: providerPrefs?.mode,
    providerDef,
  });
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
  const initialModel = normalizeSelectedModelId(initialValues?.model);
  const preferredModel = normalizeSelectedModelId(providerPrefs?.model);
  // COMPAT(default-model-id): added in v0.7.2, remove after 2026-12-06.
  // Older drafts used "default" before providers exposed concrete model IDs.
  if ((initialModel || preferredModel) === "default" && availableModels?.length) {
    return (
      findModelByReference(availableModels, "default")?.id || resolveDefaultModelId(availableModels)
    );
  }
  if (initialModel) {
    return !availableModels
      ? initialModel
      : resolveCanonicalModelId(availableModels, initialModel) || initialModel;
  }
  if (preferredModel) {
    return !availableModels
      ? preferredModel
      : resolveCanonicalModelId(availableModels, preferredModel) || preferredModel;
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
  availableModels: AgentModelDefinition[] | null;
}): string {
  const {
    provider,
    userModified,
    currentThinkingOptionId,
    modelId,
    initialValues,
    providerPrefs,
    availableModels,
  } = input;
  if (!provider) return "";
  if (userModified) return currentThinkingOptionId;
  const initialThinkingOptionId =
    typeof initialValues?.thinkingOptionId === "string"
      ? initialValues.thinkingOptionId.trim()
      : "";
  const preferredThinking = resolvePreferredThinkingOptionId({
    availableModels,
    providerPrefs,
    modelId,
  });
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
    availableModels,
  });

  if (result.provider && availableModels) {
    result.thinkingOptionId = resolveThinkingOptionId({
      availableModels,
      modelId: result.model,
      requestedThinkingOptionId: result.thinkingOptionId,
    });
  }

  return result;
}

export function resolveFormStateFromProviderModels(
  initialValues: FormInitialValues | undefined,
  preferences: FormPreferences | null,
  providerModelsByProvider: ProviderModelsByProvider,
  userModified: UserModifiedFields,
  currentState: FormState,
  allowedProviderMap: Map<AgentProvider, AgentProviderDefinition>,
): FormState {
  const providerResolved = resolveFormState(
    initialValues,
    preferences,
    null,
    userModified,
    currentState,
    allowedProviderMap,
  );
  const availableModels = providerResolved.provider
    ? (providerModelsByProvider.get(providerResolved.provider) ?? null)
    : null;

  return resolveFormState(
    initialValues,
    preferences,
    availableModels,
    userModified,
    currentState,
    allowedProviderMap,
  );
}

function pickNextModeForProvider(input: {
  providerDef: AgentProviderDefinition | undefined;
  providerPrefs: ProviderPrefs | undefined;
}): string {
  const { providerDef, providerPrefs } = input;
  return resolvePreferredModeId({
    preferredModeId: providerPrefs?.mode,
    providerDef,
  });
}

function pickNextModeForProviderAndModel(input: {
  currentProvider: AgentProvider | null;
  currentModeId: string;
  provider: AgentProvider;
  providerDef: AgentProviderDefinition | undefined;
  providerPrefs: ProviderPrefs | undefined;
}): string {
  const currentModeId = normalizeSelectedModeId(input.currentModeId);
  if (input.currentProvider === input.provider && currentModeId) return currentModeId;
  return pickNextModeForProvider({
    providerDef: input.providerDef,
    providerPrefs: input.providerPrefs,
  });
}

function pickNextThinkingOptionForProvider(input: {
  providerModels: AgentModelDefinition[] | null;
  providerPrefs: ProviderPrefs | undefined;
  modelId: string;
}): string {
  const { providerModels, providerPrefs, modelId } = input;
  const preferredThinking = resolvePreferredThinkingOptionId({
    availableModels: providerModels,
    providerPrefs,
    modelId,
  });
  return resolveThinkingOptionId({
    availableModels: providerModels,
    modelId,
    requestedThinkingOptionId: preferredThinking,
  });
}

function pickNextThinkingOptionForTarget(input: {
  availableModels: AgentModelDefinition[] | null;
  providerPrefs: ProviderPrefs | undefined;
  modelId: string;
  currentModelId: string;
  currentThinkingOptionId: string;
  isSameProvider: boolean;
}): string {
  const requestedThinkingOptionId =
    input.isSameProvider &&
    resolveCanonicalModelId(input.availableModels, input.currentModelId) === input.modelId
      ? input.currentThinkingOptionId
      : resolvePreferredThinkingOptionId({
          availableModels: input.availableModels,
          providerPrefs: input.providerPrefs,
          modelId: input.modelId,
        });
  return resolveThinkingOptionId({
    availableModels: input.availableModels,
    modelId: input.modelId,
    requestedThinkingOptionId,
  });
}

function completeResolution(
  state: AgentFormReducerState,
  action: CompleteResolutionAction,
): AgentFormReducerState {
  if (state.resolution.status === "completed") {
    return state;
  }
  const resolved = resolveFormStateFromProviderModels(
    action.initialValues,
    action.preferences,
    action.providerModelsByProvider,
    state.userModified,
    state.form,
    action.allowedProviderMap,
  );
  const nextState = { ...state, resolution: { status: "completed" } as const };
  if (!hasFormStateChanged(state.form, resolved)) return nextState;
  return { ...nextState, form: resolved };
}

function applyProfile(state: AgentFormReducerState, action: ApplyProfileAction) {
  const preferredModelId = action.modelId || action.providerPrefs?.model || "";
  const normalizedModelId = resolveCanonicalModelId(action.providerModels, preferredModelId);
  const nextModelId = normalizedModelId || resolveDefaultModelId(action.providerModels);
  const availableModeIds = new Set(action.providerDef?.modes.map((mode) => mode.id) ?? []);
  const preferredModeId = action.modeId || action.providerPrefs?.mode || "";
  const defaultModeId = action.providerDef?.defaultModeId ?? "";
  let nextModeId = "";
  if (availableModeIds.has(preferredModeId)) {
    nextModeId = preferredModeId;
  } else if (availableModeIds.has(defaultModeId)) {
    nextModeId = defaultModeId;
  }
  const nextThinkingOptionId =
    action.thinkingOptionId ||
    pickNextThinkingOptionForProvider({
      providerModels: action.providerModels,
      providerPrefs: action.providerPrefs,
      modelId: nextModelId,
    });
  return {
    ...state,
    form: {
      ...state.form,
      provider: action.provider,
      model: nextModelId,
      modeId: nextModeId,
      thinkingOptionId: nextThinkingOptionId,
    },
    userModified: {
      ...state.userModified,
      provider: true,
      model: true,
      modeId: true,
      thinkingOptionId: true,
    },
  };
}

function sameInitialValues(left: FormInitialValues = {}, right: FormInitialValues = {}): boolean {
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    left.modeId === right.modeId &&
    left.thinkingOptionId === right.thinkingOptionId
  );
}

function receiveInputs(
  state: AgentFormReducerState,
  action: AgentFormInputs,
): AgentFormReducerState {
  const active = action.isVisible && action.isCreateFlow;
  const previous = state.inputs;
  const initial = action.initialValues;
  const changed =
    previous?.active !== active ||
    previous.serverId !== action.serverId ||
    !sameInitialValues(previous.initialValues, initial);
  let next = state;
  if (changed) {
    next = {
      ...resolveAgentForm(state, { type: action.isVisible ? "REQUEST_RESOLUTION" : "RESET" }),
      inputs: { serverId: action.serverId, initialValues: initial, active },
    };
  }
  if (!active || action.isPreferencesLoading || !action.serverId || !action.hasSnapshot)
    return next;
  return completeResolution(next, { ...action, type: "COMPLETE_RESOLUTION" });
}

export function resolveAgentForm(
  state: AgentFormReducerState,
  action: AgentFormAction,
): AgentFormReducerState {
  switch (action.type) {
    case "INPUTS_CHANGED":
      return receiveInputs(state, action);
    case "REQUEST_RESOLUTION":
      return {
        ...state,
        userModified: INITIAL_USER_MODIFIED,
        resolution: PENDING_AGENT_FORM_RESOLUTION,
      };

    case "COMPLETE_RESOLUTION":
      return completeResolution(state, action);

    case "SET_PROVIDER_AND_MODEL_FROM_USER": {
      const normalizedModelId = resolveCanonicalModelId(action.providerModels, action.modelId);
      const nextModelId = normalizedModelId || resolveDefaultModelId(action.providerModels);
      const nextThinkingOptionId = pickNextThinkingOptionForTarget({
        availableModels: action.providerModels,
        modelId: nextModelId,
        providerPrefs: action.providerPrefs,
        currentModelId: state.form.model,
        currentThinkingOptionId: state.form.thinkingOptionId,
        isSameProvider: state.form.provider === action.provider,
      });
      const nextModeId = pickNextModeForProviderAndModel({
        currentProvider: state.form.provider,
        currentModeId: state.form.modeId,
        provider: action.provider,
        providerDef: action.providerDef,
        providerPrefs: action.providerPrefs,
      });
      return {
        ...state,
        form: {
          ...state.form,
          provider: action.provider,
          model: nextModelId,
          modeId: nextModeId,
          thinkingOptionId: nextThinkingOptionId,
        },
        userModified: { ...state.userModified, provider: true, model: true },
      };
    }

    case "APPLY_PROFILE_FROM_USER": {
      return applyProfile(state, action);
    }

    case "SET_MODE_FROM_USER":
      return {
        ...state,
        form: { ...state.form, modeId: action.modeId },
        userModified: { ...state.userModified, modeId: true },
      };

    case "SET_MODEL_FROM_USER": {
      const normalizedModelId = resolveCanonicalModelId(action.availableModels, action.modelId);
      const nextModelId = normalizedModelId || resolveDefaultModelId(action.availableModels);
      const nextThinkingOptionId = pickNextThinkingOptionForTarget({
        availableModels: action.availableModels,
        modelId: nextModelId,
        providerPrefs: action.providerPrefs,
        currentModelId: state.form.model,
        currentThinkingOptionId: state.form.thinkingOptionId,
        isSameProvider: true,
      });
      return {
        ...state,
        form: {
          ...state.form,
          model: nextModelId,
          thinkingOptionId: nextThinkingOptionId,
        },
        userModified: { ...state.userModified, model: true },
      };
    }

    case "CLEAR_PROVIDER_SELECTION_FROM_USER":
      return {
        ...state,
        form: {
          ...state.form,
          provider: null,
          model: "",
          modeId: "",
          thinkingOptionId: "",
        },
        userModified: {
          ...state.userModified,
          provider: true,
          model: true,
          modeId: true,
          thinkingOptionId: true,
        },
      };

    case "SET_THINKING_OPTION_FROM_USER":
      return {
        ...state,
        form: { ...state.form, thinkingOptionId: action.thinkingOptionId },
        userModified: { ...state.userModified, thinkingOptionId: true },
      };

    case "RESET":
      return {
        ...state,
        userModified: INITIAL_USER_MODIFIED,
        resolution: INITIAL_AGENT_FORM_RESOLUTION,
      };
    default:
      throw new Error("unreachable");
  }
}
