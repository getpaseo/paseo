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

/**
 * Pre-fill values for create mode. Only used when `mode === "create"`; edit
 * mode always seeds from the stored `profile` and ignores this.
 */
export interface AgentProfileSeed {
  provider: string;
  modelId?: string;
  name?: string;
}

export interface AgentProfileFormSnapshot {
  mode: "create" | "edit";
  profile?: AgentProfile;
  seed?: AgentProfileSeed;
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
  color: string;
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
  setAppearance: (value: { icon: string; color: string }) => void;
  setNotes: (value: string) => void;
  setProvider: (providerId: string, display: AgentProfileFormDisplay) => void;
  setModel: (modelId: string, display: AgentProfileFormDisplay | null) => void;
  setMode: (modeId: string, display: AgentProfileFormDisplay | null) => void;
  setThinking: (thinkingOptionId: string, display: AgentProfileFormDisplay | null) => void;
  setFeatureValue: (featureId: string, value: unknown) => void;
  setSubmitting: (value: boolean) => void;
  setSubmitError: (value: string | null) => void;
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
  return models.map((model) =>
    formOption({
      id: model.id,
      label: model.label,
      // Models are labelled by family, so the id is the only thing that
      // distinguishes two entries with the same label.
      description: model.description ?? model.id,
      testID: `agent-profile-model-option-${model.id}`,
    }),
  );
}

function buildModeOptions(modes: readonly AgentMode[]): AgentProfileFormOption[] {
  return modes.map((mode) =>
    formOption({
      id: mode.id,
      label: formatAgentModeLabel(mode),
      description: mode.description,
      testID: `agent-profile-mode-option-${mode.id}`,
    }),
  );
}

function buildThinkingOptions(options: readonly AgentSelectOption[]): AgentProfileFormOption[] {
  return options.map((option) =>
    formOption({
      id: option.id,
      label: formatThinkingOptionLabel(option),
      description: option.description,
      testID: `agent-profile-thinking-option-${option.id}`,
    }),
  );
}

/**
 * Every selection resolves to a concrete id.
 *
 * Each list used to carry a synthetic "Provider default" row. It read as a value
 * you could choose but stored an absent one, so a profile that looked fully
 * specified would apply whatever the host preferred at the time — and two hosts
 * would materialize the same profile differently. The schedule form never
 * offered that row; this form now matches it and seeds the catalog's own default
 * instead, so what the form shows is what the profile stores.
 */
function defaultModelId(models: readonly AgentModelDefinition[]): string {
  return models.find((model) => model.isDefault)?.id ?? models[0]?.id ?? "";
}

function defaultModeId(entry: ProviderSnapshotEntry | null, modes: readonly AgentMode[]): string {
  return entry?.defaultModeId ?? modes[0]?.id ?? "";
}

function defaultThinkingOptionId(model: AgentModelDefinition | null): string {
  const options = model?.thinkingOptions ?? [];
  return (
    model?.defaultThinkingOptionId ??
    options.find((option) => option.isDefault)?.id ??
    options[0]?.id ??
    ""
  );
}

function seedSelections(
  next: AgentProfileFormState,
  input: {
    entry: ProviderSnapshotEntry | null;
    models: readonly AgentModelDefinition[];
    modes: readonly AgentMode[];
  },
): AgentProfileFormState {
  const modelId = next.modelId || defaultModelId(input.models);
  const modeId = next.modeId || defaultModeId(input.entry, input.modes);
  const thinkingOptionId =
    next.thinkingOptionId || defaultThinkingOptionId(resolveEffectiveModel(input.models, modelId));
  if (
    modelId === next.modelId &&
    modeId === next.modeId &&
    thinkingOptionId === next.thinkingOptionId
  ) {
    return next;
  }
  return { ...next, modelId, modeId, thinkingOptionId };
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
    ...(state.color ? { color: state.color } : {}),
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
  const seed = snapshot.mode === "create" ? snapshot.seed : undefined;
  const name = seed?.name ?? profile.name;
  const provider = seed?.provider ?? profile.provider;
  const modelId = seed?.modelId ?? profile.model ?? "";
  return {
    mode: snapshot.mode,
    name,
    icon: profile.icon ?? "",
    color: profile.color ?? "",
    notes: profile.notes ?? "",
    provider,
    modelId,
    modeId: profile.modeId ?? "",
    thinkingOptionId: profile.thinkingOptionId ?? "",
    featureValues: { ...profile.featureValues },
    providerOptions: [],
    modelOptions: [],
    modeOptions: [],
    thinkingOptions: [],
    features: [],
    providerDisplay: seedDisplay(provider),
    modelDisplay: seedDisplay(modelId),
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

  function derive(incoming: AgentProfileFormState): AgentProfileFormState {
    const models = resolveModels(entries, incoming.provider);
    const modes = resolveModes(entries, incoming.provider);
    const next = seedSelections(incoming, {
      entry: findEntry(entries, incoming.provider),
      models,
      modes,
    });
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
    setAppearance: (value) =>
      publish((current) => ({ ...current, icon: value.icon, color: value.color })),
    setNotes: (value) => publish((current) => ({ ...current, notes: value })),
    setProvider: (providerId, display) =>
      publish((current) => {
        if (current.provider === providerId) {
          return current;
        }
        // Everything below the provider is provider-scoped: a model id, mode id,
        // thinking id or feature id from the old provider means nothing here.
        // Clearing them is enough — `derive` seeds the new provider's defaults.
        return {
          ...current,
          provider: providerId,
          providerDisplay: display,
          modelId: "",
          modelDisplay: null,
          modeId: "",
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
