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
import {
  isModelVisible,
  resolveDefaultModelCandidates,
  type ModelVisibilityByProvider,
  type ProviderModelVisibility,
} from "./model-visibility";

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
  /**
   * True when `form.model` names a model the user asked for: a model pick or a
   * profile's own model. A provider-only pick, a mode change, or a thinking
   * change leaves the defaulted model implicit, which is why this is separate
   * from `userModified.model`. Only an explicit model survives a later
   * visibility change; an implicit one is re-resolved. Absent means implicit.
   */
  modelIsExplicit?: boolean;
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
  modelVisibility?: ModelVisibilityByProvider | undefined;
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
      modelVisibility?: ModelVisibilityByProvider | undefined;
    }
  | {
      type: "SET_PROVIDER_AND_MODEL_FROM_USER";
      provider: AgentProvider;
      modelId: string;
      providerDef: AgentProviderDefinition | undefined;
      providerModels: AgentModelDefinition[] | null;
      providerPrefs?: ProviderPrefs | undefined;
      modelVisibility?: ProviderModelVisibility | undefined;
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
      modelVisibility?: ProviderModelVisibility | undefined;
    }
  | { type: "SET_MODE_FROM_USER"; modeId: string }
  | {
      type: "SET_MODEL_FROM_USER";
      modelId: string;
      availableModels: AgentModelDefinition[] | null;
      providerPrefs: ProviderPrefs | undefined;
      modelVisibility?: ProviderModelVisibility | undefined;
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

/**
 * Fresh defaults only. A hidden model is never picked for the user; an explicit
 * choice they already made is resolved through the full catalog instead.
 */
export function resolveVisibleDefaultModelId(
  availableModels: AgentModelDefinition[] | null,
  visibility: ProviderModelVisibility | undefined,
): string {
  return resolveDefaultModelId(resolveDefaultModelCandidates(availableModels, visibility));
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
  visibility: ProviderModelVisibility | undefined;
}): string {
  const {
    provider,
    userModified,
    currentModel,
    initialValues,
    providerPrefs,
    availableModels,
    visibility,
  } = input;
  if (userModified) return currentModel;
  if (!provider) return "";
  const initialModel = normalizeSelectedModelId(initialValues?.model);
  const preferredModel = normalizeSelectedModelId(providerPrefs?.model);
  // COMPAT(default-model-id): added in v0.7.2, remove after 2026-12-06.
  // Older drafts used "default" before providers exposed concrete model IDs.
  if ((initialModel || preferredModel) === "default" && availableModels?.length) {
    // "default" names no specific model, so it resolves like a fresh default and
    // must not land on a hidden one.
    const aliased = findModelByReference(availableModels, "default");
    if (aliased && isModelVisible(visibility, aliased.id)) return aliased.id;
    return resolveVisibleDefaultModelId(availableModels, visibility);
  }
  if (initialModel) {
    return !availableModels
      ? initialModel
      : resolveCanonicalModelId(availableModels, initialModel) || initialModel;
  }
  if (preferredModel) {
    if (!availableModels) return preferredModel;
    const canonical = resolveCanonicalModelId(availableModels, preferredModel) || preferredModel;
    // A remembered preference is a convenience default, not stated intent for
    // this form, so a hidden one falls through to the visible default instead.
    if (isModelVisible(visibility, canonical)) return canonical;
    return resolveVisibleDefaultModelId(availableModels, visibility);
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
  modelVisibility?: ModelVisibilityByProvider | undefined,
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
    visibility: result.provider ? modelVisibility?.[result.provider] : undefined,
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
  modelVisibility?: ModelVisibilityByProvider | undefined,
): FormState {
  const providerResolved = resolveFormState(
    initialValues,
    preferences,
    null,
    userModified,
    currentState,
    allowedProviderMap,
    modelVisibility,
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
    modelVisibility,
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

/**
 * A completed form keeps receiving inputs, and model visibility is one of them.
 * An implicit model (remembered preference or fresh default) that the user hid
 * since resolution is re-resolved the same way a fresh form would resolve it,
 * so hide-all empties it and readiness blocks instead of launching a hidden
 * model. Explicit choices are left alone: a stated initial model, a model the
 * user picked, or a profile's own model.
 */
function reconcileImplicitModel(
  state: AgentFormReducerState,
  action: CompleteResolutionAction,
): AgentFormReducerState {
  if (state.modelIsExplicit) return state;
  const provider = state.form.provider;
  if (!provider) return state;
  const visibility = action.modelVisibility?.[provider];
  const currentModel = state.form.model;
  if (currentModel && isModelVisible(visibility, currentModel)) return state;

  const availableModels = action.providerModelsByProvider.get(provider) ?? null;
  const providerPrefs = action.preferences?.providerPreferences?.[provider];
  const nextModel = resolveModelField({
    provider,
    userModified: false,
    currentModel,
    // A provider-only pick moved the form off the initial context, so the
    // initial model no longer applies to the provider it is resolving for.
    initialValues: state.userModified.model ? undefined : action.initialValues,
    providerPrefs,
    availableModels,
    visibility,
  });
  if (nextModel === currentModel) return state;

  const requestedThinkingOptionId = state.userModified.thinkingOptionId
    ? state.form.thinkingOptionId
    : resolvePreferredThinkingOptionId({ availableModels, providerPrefs, modelId: nextModel });
  const nextThinkingOptionId = resolveThinkingOptionId({
    availableModels,
    modelId: nextModel,
    requestedThinkingOptionId,
  });
  return {
    ...state,
    form: { ...state.form, model: nextModel, thinkingOptionId: nextThinkingOptionId },
  };
}

function completeResolution(
  state: AgentFormReducerState,
  action: CompleteResolutionAction,
): AgentFormReducerState {
  if (state.resolution.status === "completed") {
    return reconcileImplicitModel(state, action);
  }
  const resolved = resolveFormStateFromProviderModels(
    action.initialValues,
    action.preferences,
    action.providerModelsByProvider,
    state.userModified,
    state.form,
    action.allowedProviderMap,
    action.modelVisibility,
  );
  const nextState = { ...state, resolution: { status: "completed" } as const };
  if (!hasFormStateChanged(state.form, resolved)) return nextState;
  return { ...nextState, form: resolved };
}

function applyProfile(state: AgentFormReducerState, action: ApplyProfileAction) {
  // A saved profile is stated intent, so its own model survives even when
  // hidden. The remembered preference standing in for it is only a default.
  const hasExplicitModelId = normalizeSelectedModelId(action.modelId).length > 0;
  const preferredModelId = action.modelId || action.providerPrefs?.model || "";
  const normalizedModelId = resolveCanonicalModelId(action.providerModels, preferredModelId);
  const keepsNormalizedModelId =
    normalizedModelId !== "" &&
    (hasExplicitModelId || isModelVisible(action.modelVisibility, normalizedModelId));
  const nextModelId = keepsNormalizedModelId
    ? normalizedModelId
    : resolveVisibleDefaultModelId(action.providerModels, action.modelVisibility);
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
    // Only the profile's own model is stated intent; a profile that leaves the
    // model to the remembered preference gets an implicit default.
    modelIsExplicit: hasExplicitModelId && keepsNormalizedModelId,
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
        modelIsExplicit: false,
      };

    case "COMPLETE_RESOLUTION":
      return completeResolution(state, action);

    case "SET_PROVIDER_AND_MODEL_FROM_USER": {
      const normalizedModelId = resolveCanonicalModelId(action.providerModels, action.modelId);
      const nextModelId =
        normalizedModelId ||
        resolveVisibleDefaultModelId(action.providerModels, action.modelVisibility);
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
        // A provider-only pick defaulted the model, so it stays implicit.
        modelIsExplicit: normalizedModelId !== "",
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
      const nextModelId =
        normalizedModelId ||
        resolveVisibleDefaultModelId(action.availableModels, action.modelVisibility);
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
        modelIsExplicit: normalizedModelId !== "",
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
        modelIsExplicit: false,
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
        modelIsExplicit: false,
      };
    default:
      throw new Error("unreachable");
  }
}
