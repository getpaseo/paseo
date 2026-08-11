import type {
  AgentFeature,
  AgentMode,
  AgentModelDefinition,
  AgentSelectOption,
  ProviderSnapshotEntry,
} from "@getpaseo/protocol/agent-types";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { formatAgentModeLabel, formatThinkingOptionLabel } from "@/agent-controls/labels";
import { applyFeatureValues, pruneFeatureValues } from "@/hooks/feature-preferences";
import { filterSelectableModels } from "@/provider-selection/model-catalog";
import { i18n } from "@/i18n/i18next";

/**
 * The persisted profile minus the id; the list owns identity.
 *
 * `Omit` does not work here. `AgentProfileSchema` is `.passthrough()`, so
 * `AgentProfile` carries a `[key: string]: unknown` index signature, and
 * `Exclude<keyof AgentProfile, "id">` stays `string | number` — the named keys
 * come back as `unknown` and `name`/`provider` stop being required. Mapping
 * `keyof` with an `as` filter drops the index signature and the id together.
 */
export type AgentProfileValue = {
  [K in keyof AgentProfile as string extends K
    ? never
    : K extends "id"
      ? never
      : K]: AgentProfile[K];
};

export interface AgentProfileFormDisplay {
  label: string;
  description?: string;
}

export interface AgentProfileFormOption {
  id: string;
  value: string;
  label: string;
  description?: string;
  testID: string;
}

export interface AgentProfileFormSnapshot {
  mode: "create" | "edit";
  profile?: AgentProfile;
}

/**
 * The inputs a feature listing needs. Features are provider-scoped and change
 * with model/mode/thinking, so every one of those is part of the request.
 */
export interface AgentProfileFeatureRequest {
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
}

export type AgentProfileResolutionStatus = "idle" | "pending" | "complete";

export interface AgentProfileFormDisclosure {
  showModelField: boolean;
  showModeField: boolean;
  showThinkingField: boolean;
  showFeaturesField: boolean;
}

export interface AgentProfileFormState {
  mode: "create" | "edit";
  name: string;
  icon: string;
  notes: string;
  provider: string;
  modelId: string;
  modeId: string;
  thinkingOptionId: string;
  featureValues: Record<string, unknown>;

  providerOptions: AgentProfileFormOption[];
  modelOptions: AgentProfileFormOption[];
  modeOptions: AgentProfileFormOption[];
  thinkingOptions: AgentProfileFormOption[];
  features: AgentFeature[];

  providerDisplay: AgentProfileFormDisplay | null;
  modelDisplay: AgentProfileFormDisplay | null;
  modeDisplay: AgentProfileFormDisplay | null;
  thinkingDisplay: AgentProfileFormDisplay | null;

  catalogResolution: AgentProfileResolutionStatus;
  featureResolution: AgentProfileResolutionStatus;
  featureRequest: AgentProfileFeatureRequest | null;
  featureRequestKey: string | null;

  disclosure: AgentProfileFormDisclosure;
  isSubmitting: boolean;
  submitError: string | null;
  canSubmit: boolean;
  submitValue: AgentProfileValue | null;
}

export interface AgentProfileFormModel {
  getState: () => AgentProfileFormState;
  subscribe: (listener: () => void) => () => void;
  close: () => void;
  /** Late input: the host-scoped provider catalog. Never touches selections. */
  applyProviderCatalog: (entries: readonly ProviderSnapshotEntry[]) => void;
  /** Late input: the feature list for one request. Stale keys are ignored. */
  applyFeatures: (requestKey: string, features: readonly AgentFeature[]) => void;
  /** Resolve a request that produced no usable features (provider error). */
  applyFeaturesUnavailable: (requestKey: string) => void;
  setName: (value: string) => void;
  setIcon: (value: string) => void;
  setNotes: (value: string) => void;
  setProvider: (providerId: string, display: AgentProfileFormDisplay) => void;
  setModel: (modelId: string, display: AgentProfileFormDisplay | null) => void;
  setMode: (modeId: string, display: AgentProfileFormDisplay | null) => void;
  setThinking: (thinkingOptionId: string, display: AgentProfileFormDisplay | null) => void;
  setFeatureValue: (featureId: string, value: unknown) => void;
  setSubmitting: (value: boolean) => void;
  setSubmitError: (value: string | null) => void;
}

const UNSET_OPTION_ID = "__unset__";

function unsetOption(kind: "model" | "mode" | "thinking"): AgentProfileFormOption {
  return {
    id: UNSET_OPTION_ID,
    value: "",
    label: i18n.t("settings.host.agentProfiles.providerDefault"),
    testID: `agent-profile-${kind}-option-default`,
  };
}

function findEntry(
  entries: readonly ProviderSnapshotEntry[],
  provider: string,
): ProviderSnapshotEntry | null {
  if (!provider) {
    return null;
  }
  return entries.find((entry) => entry.provider === provider) ?? null;
}

function resolveModels(
  entries: readonly ProviderSnapshotEntry[],
  provider: string,
): AgentModelDefinition[] {
  return filterSelectableModels(findEntry(entries, provider)?.models ?? null) ?? [];
}

function resolveModes(entries: readonly ProviderSnapshotEntry[], provider: string): AgentMode[] {
  return findEntry(entries, provider)?.modes ?? [];
}

/**
 * Thinking options hang off a model, so an unset model still has to resolve to
 * the model the daemon would pick — otherwise the field disappears whenever the
 * user leaves the model on "provider default".
 */
function resolveEffectiveModel(
  models: readonly AgentModelDefinition[],
  modelId: string,
): AgentModelDefinition | null {
  const trimmed = modelId.trim();
  if (trimmed) {
    return models.find((model) => model.id === trimmed) ?? null;
  }
  return models.find((model) => model.isDefault) ?? models[0] ?? null;
}

function resolveThinkingOptions(
  entries: readonly ProviderSnapshotEntry[],
  provider: string,
  modelId: string,
): AgentSelectOption[] {
  return resolveEffectiveModel(resolveModels(entries, provider), modelId)?.thinkingOptions ?? [];
}

/** Every real option is selected by its own id; only the unset row differs. */
function formOption(input: {
  id: string;
  label: string;
  description: string | undefined;
  testID: string;
}): AgentProfileFormOption {
  return {
    id: input.id,
    value: input.id,
    label: input.label,
    ...(input.description ? { description: input.description } : {}),
    testID: input.testID,
  };
}

function buildProviderOptions(entries: readonly ProviderSnapshotEntry[]): AgentProfileFormOption[] {
  return entries
    .filter((entry) => entry.enabled)
    .map((entry) =>
      formOption({
        id: entry.provider,
        label: entry.label ?? entry.provider,
        description: entry.description,
        testID: `agent-profile-provider-option-${entry.provider}`,
      }),
    );
}

function buildModelOptions(models: readonly AgentModelDefinition[]): AgentProfileFormOption[] {
  return [
    unsetOption("model"),
    ...models.map((model) =>
      formOption({
        id: model.id,
        label: model.label,
        // Models are labelled by family, so the id is the only thing that
        // distinguishes two entries with the same label.
        description: model.description ?? model.id,
        testID: `agent-profile-model-option-${model.id}`,
      }),
    ),
  ];
}

function buildModeOptions(modes: readonly AgentMode[]): AgentProfileFormOption[] {
  return [
    unsetOption("mode"),
    ...modes.map((mode) =>
      formOption({
        id: mode.id,
        label: formatAgentModeLabel(mode),
        description: mode.description,
        testID: `agent-profile-mode-option-${mode.id}`,
      }),
    ),
  ];
}

function buildThinkingOptions(options: readonly AgentSelectOption[]): AgentProfileFormOption[] {
  if (options.length === 0) {
    return [];
  }
  return [
    unsetOption("thinking"),
    ...options.map((option) =>
      formOption({
        id: option.id,
        label: formatThinkingOptionLabel(option),
        description: option.description,
        testID: `agent-profile-thinking-option-${option.id}`,
      }),
    ),
  ];
}

/**
 * Selected labels upgrade from the stored id to the catalog label once the
 * catalog lands, and fall back to the id when the catalog does not know the
 * value. They never blank out — a profile pointing at a retired model still
 * reads as that model.
 */
function refineDisplay(
  current: AgentProfileFormDisplay | null,
  selectedId: string,
  resolvedLabel: string | null,
): AgentProfileFormDisplay | null {
  if (!selectedId) {
    return null;
  }
  if (resolvedLabel) {
    return { label: resolvedLabel };
  }
  return current ?? { label: selectedId };
}

function buildFeatureRequest(state: AgentProfileFormState): AgentProfileFeatureRequest | null {
  if (!state.provider) {
    return null;
  }
  return {
    provider: state.provider,
    ...(state.modelId ? { model: state.modelId } : {}),
    ...(state.modeId ? { modeId: state.modeId } : {}),
    ...(state.thinkingOptionId ? { thinkingOptionId: state.thinkingOptionId } : {}),
  };
}

export function buildFeatureRequestKey(request: AgentProfileFeatureRequest | null): string | null {
  if (!request) {
    return null;
  }
  return [
    request.provider,
    request.model ?? "",
    request.modeId ?? "",
    request.thinkingOptionId ?? "",
  ].join("|");
}

function buildSubmitValue(state: AgentProfileFormState): AgentProfileValue | null {
  const name = state.name.trim();
  const notes = state.notes.trim();
  if (!name || !state.provider) {
    return null;
  }
  return {
    name,
    ...(state.icon ? { icon: state.icon } : {}),
    provider: state.provider,
    ...(state.modelId ? { model: state.modelId } : {}),
    ...(state.modeId ? { modeId: state.modeId } : {}),
    ...(state.thinkingOptionId ? { thinkingOptionId: state.thinkingOptionId } : {}),
    ...(Object.keys(state.featureValues).length > 0 ? { featureValues: state.featureValues } : {}),
    ...(notes ? { notes } : {}),
  };
}

function resolveFeatureStatus(
  featureRequestKey: string | null,
  featuresAreCurrent: boolean,
): AgentProfileResolutionStatus {
  if (featureRequestKey === null) {
    return "idle";
  }
  return featuresAreCurrent ? "complete" : "pending";
}

const BLANK_PROFILE: AgentProfileValue = { name: "", provider: "" };

/** A stored id doubles as its own label until the catalog can upgrade it. */
function seedDisplay(value: string | undefined): AgentProfileFormDisplay | null {
  return value ? { label: value } : null;
}

/**
 * Edit mode seeds every value AND display from the stored profile alone: the
 * catalog is not loaded yet, so `applyProviderCatalog` does the upgrading later.
 */
function buildInitialState(snapshot: AgentProfileFormSnapshot): AgentProfileFormState {
  const profile = snapshot.profile ?? BLANK_PROFILE;
  return {
    mode: snapshot.mode,
    name: profile.name,
    icon: profile.icon ?? "",
    notes: profile.notes ?? "",
    provider: profile.provider,
    modelId: profile.model ?? "",
    modeId: profile.modeId ?? "",
    thinkingOptionId: profile.thinkingOptionId ?? "",
    featureValues: { ...profile.featureValues },
    providerOptions: [],
    modelOptions: [],
    modeOptions: [],
    thinkingOptions: [],
    features: [],
    providerDisplay: seedDisplay(profile.provider),
    modelDisplay: seedDisplay(profile.model),
    modeDisplay: seedDisplay(profile.modeId),
    thinkingDisplay: seedDisplay(profile.thinkingOptionId),
    catalogResolution: "idle",
    featureResolution: "idle",
    featureRequest: null,
    featureRequestKey: null,
    disclosure: {
      showModelField: false,
      showModeField: false,
      showThinkingField: false,
      showFeaturesField: false,
    },
    isSubmitting: false,
    submitError: null,
    canSubmit: false,
    submitValue: null,
  };
}

export function openAgentProfileForm(snapshot: AgentProfileFormSnapshot): AgentProfileFormModel {
  let entries: readonly ProviderSnapshotEntry[] = [];
  let catalogResolution: AgentProfileResolutionStatus = "idle";
  let resolvedFeatureKey: string | null = null;
  let resolvedFeatures: AgentFeature[] = [];
  let listeners = new Set<() => void>();
  let closed = false;

  function derive(next: AgentProfileFormState): AgentProfileFormState {
    const models = resolveModels(entries, next.provider);
    const modes = resolveModes(entries, next.provider);
    const thinking = resolveThinkingOptions(entries, next.provider, next.modelId);
    const featureRequest = buildFeatureRequest(next);
    const featureRequestKey = buildFeatureRequestKey(featureRequest);
    const featuresAreCurrent =
      featureRequestKey !== null && featureRequestKey === resolvedFeatureKey;
    const features = featuresAreCurrent
      ? applyFeatureValues(resolvedFeatures, next.featureValues)
      : [];
    const featureResolution = resolveFeatureStatus(featureRequestKey, featuresAreCurrent);

    const withOptions: AgentProfileFormState = {
      ...next,
      providerOptions: buildProviderOptions(entries),
      modelOptions: buildModelOptions(models),
      modeOptions: buildModeOptions(modes),
      thinkingOptions: buildThinkingOptions(thinking),
      features,
      providerDisplay: refineDisplay(
        next.providerDisplay,
        next.provider,
        findEntry(entries, next.provider)?.label ?? null,
      ),
      modelDisplay: refineDisplay(
        next.modelDisplay,
        next.modelId,
        models.find((model) => model.id === next.modelId)?.label ?? null,
      ),
      modeDisplay: refineDisplay(
        next.modeDisplay,
        next.modeId,
        (() => {
          const mode = modes.find((entry) => entry.id === next.modeId);
          return mode ? formatAgentModeLabel(mode) : null;
        })(),
      ),
      thinkingDisplay: refineDisplay(
        next.thinkingDisplay,
        next.thinkingOptionId,
        (() => {
          const option = thinking.find((entry) => entry.id === next.thinkingOptionId);
          return option ? formatThinkingOptionLabel(option) : null;
        })(),
      ),
      catalogResolution,
      featureResolution,
      featureRequest,
      featureRequestKey,
    };

    // A field appears once the catalog can populate it, and stays visible while
    // a stored value needs a home even if this host cannot resolve it.
    const hasProvider = Boolean(withOptions.provider);
    const disclosure: AgentProfileFormDisclosure = {
      showModelField: hasProvider && (models.length > 0 || Boolean(withOptions.modelId)),
      showModeField: hasProvider && (modes.length > 0 || Boolean(withOptions.modeId)),
      showThinkingField:
        hasProvider && (thinking.length > 0 || Boolean(withOptions.thinkingOptionId)),
      showFeaturesField: hasProvider && features.length > 0,
    };
    const canSubmit =
      withOptions.name.trim().length > 0 &&
      withOptions.provider.length > 0 &&
      !withOptions.isSubmitting;
    const resolved: AgentProfileFormState = { ...withOptions, disclosure, canSubmit };
    return { ...resolved, submitValue: canSubmit ? buildSubmitValue(resolved) : null };
  }

  let state: AgentProfileFormState = derive(buildInitialState(snapshot));

  function publish(mutate: (current: AgentProfileFormState) => AgentProfileFormState): void {
    if (closed) {
      return;
    }
    state = derive(mutate(state));
    for (const listener of listeners) {
      listener();
    }
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: () => {
      closed = true;
      listeners = new Set();
    },
    applyProviderCatalog: (nextEntries) => {
      entries = [...nextEntries];
      catalogResolution = "complete";
      publish((current) => current);
    },
    applyFeatures: (requestKey, features) => {
      if (requestKey !== state.featureRequestKey) {
        return;
      }
      resolvedFeatureKey = requestKey;
      resolvedFeatures = [...features];
      publish((current) => ({
        ...current,
        featureValues: pruneFeatureValues(current.featureValues, resolvedFeatures),
      }));
    },
    applyFeaturesUnavailable: (requestKey) => {
      if (requestKey !== state.featureRequestKey) {
        return;
      }
      resolvedFeatureKey = requestKey;
      resolvedFeatures = [];
      publish((current) => current);
    },
    setName: (value) => publish((current) => ({ ...current, name: value })),
    setIcon: (value) => publish((current) => ({ ...current, icon: value })),
    setNotes: (value) => publish((current) => ({ ...current, notes: value })),
    setProvider: (providerId, display) =>
      publish((current) => {
        if (current.provider === providerId) {
          return current;
        }
        // Everything below the provider is provider-scoped: a model id, mode id,
        // thinking id or feature id from the old provider means nothing here.
        return {
          ...current,
          provider: providerId,
          providerDisplay: display,
          modelId: "",
          modelDisplay: null,
          modeId: findEntry(entries, providerId)?.defaultModeId ?? "",
          modeDisplay: null,
          thinkingOptionId: "",
          thinkingDisplay: null,
          featureValues: {},
        };
      }),
    setModel: (modelId, display) =>
      publish((current) => {
        if (current.modelId === modelId) {
          return current;
        }
        // Thinking options are a property of the model, so a level the new model
        // does not offer has to go.
        const nextThinking = resolveThinkingOptions(entries, current.provider, modelId);
        const keepsThinking =
          current.thinkingOptionId.length > 0 &&
          nextThinking.some((option) => option.id === current.thinkingOptionId);
        return {
          ...current,
          modelId,
          modelDisplay: display,
          thinkingOptionId: keepsThinking ? current.thinkingOptionId : "",
          thinkingDisplay: keepsThinking ? current.thinkingDisplay : null,
        };
      }),
    setMode: (modeId, display) =>
      publish((current) => ({ ...current, modeId, modeDisplay: display })),
    setThinking: (thinkingOptionId, display) =>
      publish((current) => ({ ...current, thinkingOptionId, thinkingDisplay: display })),
    setFeatureValue: (featureId, value) =>
      publish((current) => ({
        ...current,
        featureValues: { ...current.featureValues, [featureId]: value },
      })),
    setSubmitting: (value) => publish((current) => ({ ...current, isSubmitting: value })),
    setSubmitError: (value) => publish((current) => ({ ...current, submitError: value })),
  };
}
