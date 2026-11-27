import type {
  AgentOptionControl,
  ProviderOptions,
  AgentMode,
  AgentModelDefinition,
  AgentSelectOption,
  ProviderSnapshotEntry,
} from "@getpaseo/protocol/agent-types";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { withoutLostControls } from "@/agent-controls/lost-controls";
import { formatAgentModeLabel, formatThinkingOptionLabel } from "@/agent-controls/labels";
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

export interface AgentProfileUnifiedModelOption {
  id: string;
  provider: string;
  providerLabel: string;
  modelId: string;
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
  /** Optional cached host catalog so the first render is already hydrated without a layout flash. */
  entries?: readonly ProviderSnapshotEntry[];
}

/**
 * The inputs a controls listing needs. Controls are provider-scoped and change
 * with model/mode/thinking, so every one of those is part of the request. The
 * profile's own options ride along so the daemon can resolve them (a legacy
 * `service_tier: "fast"` is drawn as the model's Fast tier); they are the same
 * for the life of one provider, so they are not part of the key.
 */
export interface AgentProfileControlsRequest {
  provider: string;
  providerOptions?: ProviderOptions;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
}

export type AgentProfileResolutionStatus = "idle" | "pending" | "complete";

export interface AgentProfileFormDisclosure {
  showModelField: boolean;
  showModeField: boolean;
  showThinkingField: boolean;
  showControlsField: boolean;
}

export interface AgentProfileFormState {
  mode: "create" | "edit";
  name: string;
  icon: string;
  color: string;
  systemPrompt: string;
  notes: string;
  provider: string;
  modelId: string;
  modeId: string;
  thinkingOptionId: string;
  /** The options the profile was opened with, including ones no control draws. */
  options: ProviderOptions;
  /** Changes made in this form, over `options`. */
  optionEdits: ProviderOptions;

  providerOptions: AgentProfileFormOption[];
  unifiedModelOptions: AgentProfileUnifiedModelOption[];
  modelOptions: AgentProfileFormOption[];
  modeOptions: AgentProfileFormOption[];
  thinkingOptions: AgentProfileFormOption[];
  controls: AgentOptionControl[];
  /** What the controls show: the options the daemon resolved from `options`, then the edits. */
  controlOptions: ProviderOptions;
  /** Every key an answer for this provider has drawn as a control. */
  drawnControlKeys: ReadonlySet<string>;
  /** The keys the latest answer draws as controls. */
  answeredControlKeys: ReadonlySet<string>;

  providerDisplay: AgentProfileFormDisplay | null;
  modelDisplay: AgentProfileFormDisplay | null;
  modeDisplay: AgentProfileFormDisplay | null;
  thinkingDisplay: AgentProfileFormDisplay | null;

  catalogResolution: AgentProfileResolutionStatus;
  controlsResolution: AgentProfileResolutionStatus;
  controlsPending: boolean;
  controlsRequest: AgentProfileControlsRequest | null;
  controlsRequestKey: string | null;

  disclosure: AgentProfileFormDisclosure;
  isDirty: boolean;
  /** Monotonic counter incremented on every user edit that changes the draft. */
  draftRevision: number;
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
  applyControls: (
    requestKey: string,
    resolved: { controls: readonly AgentOptionControl[]; options: ProviderOptions },
  ) => void;
  /** Resolve a request that produced no usable features (provider error). */
  applyControlsUnavailable: (requestKey: string) => void;
  setName: (value: string) => void;
  setAppearance: (value: { icon: string; color: string }) => void;
  setSystemPrompt: (value: string) => void;
  setNotes: (value: string) => void;
  setProvider: (providerId: string, display: AgentProfileFormDisplay) => void;
  setProviderModel: (
    providerId: string,
    modelId: string,
    displays: { provider: AgentProfileFormDisplay; model: AgentProfileFormDisplay | null },
  ) => void;
  setModel: (modelId: string, display: AgentProfileFormDisplay | null) => void;
  setMode: (modeId: string, display: AgentProfileFormDisplay | null) => void;
  setThinking: (thinkingOptionId: string, display: AgentProfileFormDisplay | null) => void;
  setOption: (key: string, value: unknown) => void;
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

function formatUnifiedModelDescription(providerLabel: string, model: AgentModelDefinition): string {
  if (model.description && model.description !== providerLabel) {
    return `${providerLabel} · ${model.description}`;
  }
  if (model.id !== model.label) {
    return `${providerLabel} · ${model.id}`;
  }
  return providerLabel;
}

function buildUnifiedModelOptions(
  entries: readonly ProviderSnapshotEntry[],
): AgentProfileUnifiedModelOption[] {
  const options: AgentProfileUnifiedModelOption[] = [];
  for (const entry of entries) {
    if (!entry.enabled) {
      continue;
    }
    const providerLabel = entry.label ?? entry.provider;
    const models = filterSelectableModels(entry.models ?? null) ?? [];
    if (models.length === 0) {
      options.push({
        id: `${entry.provider}:`,
        provider: entry.provider,
        providerLabel,
        modelId: "",
        label: providerLabel,
        ...(entry.description ? { description: entry.description } : {}),
        testID: `agent-profile-unified-model-${entry.provider}`,
      });
      continue;
    }
    for (const model of models) {
      options.push({
        id: `${entry.provider}:${model.id}`,
        provider: entry.provider,
        providerLabel,
        modelId: model.id,
        label: model.label,
        description: formatUnifiedModelDescription(providerLabel, model),
        testID: `agent-profile-unified-model-${entry.provider}-${model.id}`,
      });
    }
  }
  return options;
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

function buildControlsRequest(state: AgentProfileFormState): AgentProfileControlsRequest | null {
  if (!state.provider) {
    return null;
  }
  const ownOptions = ownOptionsOf(state);
  return {
    provider: state.provider,
    ...(state.modelId ? { model: state.modelId } : {}),
    ...(state.modeId ? { modeId: state.modeId } : {}),
    ...(state.thinkingOptionId ? { thinkingOptionId: state.thinkingOptionId } : {}),
    ...(Object.keys(ownOptions).length > 0 ? { providerOptions: ownOptions } : {}),
  };
}

/**
 * Everything the profile would save as its options; the daemon resolves them for the form. A
 * toggle the model in use does not draw is not saved (see `withoutLostControls`).
 */
function ownOptionsOf(
  state: Pick<
    AgentProfileFormState,
    "options" | "optionEdits" | "drawnControlKeys" | "answeredControlKeys"
  >,
): ProviderOptions {
  return withoutLostControls(
    { ...state.options, ...state.optionEdits },
    state.drawnControlKeys,
    state.answeredControlKeys,
  );
}

/** The part of a request that decides which controls exist; options only change their values. */
function buildControlsScopeKey(request: AgentProfileControlsRequest | null): string | null {
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

export function buildControlsRequestKey(
  request: AgentProfileControlsRequest | null,
): string | null {
  if (!request) {
    return null;
  }
  const scope = buildControlsScopeKey(request);
  return request.providerOptions
    ? `${scope}|${JSON.stringify(Object.entries(request.providerOptions).sort(([a], [b]) => a.localeCompare(b)))}`
    : scope;
}

function stableOptionsKey(record: ProviderOptions): string {
  const keys = Object.keys(record).sort();
  if (keys.length === 0) {
    return "";
  }
  return JSON.stringify(keys.map((key) => [key, record[key]]));
}

function formDraftFingerprint(state: AgentProfileFormState): string {
  return JSON.stringify([
    state.name.trim(),
    state.icon,
    state.color,
    state.provider,
    state.modelId,
    state.modeId,
    state.thinkingOptionId,
    state.systemPrompt.trim(),
    state.notes.trim(),
    stableOptionsKey(ownOptionsOf(state)),
  ]);
}

function buildSubmitValue(state: AgentProfileFormState): AgentProfileValue | null {
  const name = state.name.trim();
  const systemPrompt = state.systemPrompt.trim();
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
    // Always sent, empty included: the daemon reads a write without `options` as one from an
    // app that predates them and keeps the profile's stored options.
    options: ownOptionsOf(state),
    // COMPAT(agentProfileSystemPrompt): added in v0.17.6, remove after 2027-06-01.
    // Always sent, empty included: the daemon treats an omitted `systemPrompt` as a write from
    // an older app and preserves the stored prompt; `""` explicitly clears it.
    systemPrompt,
    ...(notes ? { notes } : {}),
  };
}

function resolveControlsStatus(
  controlsRequestKey: string | null,
  featuresAreCurrent: boolean,
): AgentProfileResolutionStatus {
  if (controlsRequestKey === null) {
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
    systemPrompt: profile.systemPrompt ?? "",
    notes: profile.notes ?? "",
    provider,
    modelId,
    modeId: profile.modeId ?? "",
    thinkingOptionId: profile.thinkingOptionId ?? "",
    options: { ...profile.options },
    optionEdits: {},
    providerOptions: [],
    unifiedModelOptions: [],
    modelOptions: [],
    modeOptions: [],
    thinkingOptions: [],
    controls: [],
    controlOptions: {},
    drawnControlKeys: new Set(),
    answeredControlKeys: new Set(),
    providerDisplay: seedDisplay(provider),
    modelDisplay: seedDisplay(modelId),
    modeDisplay: seedDisplay(profile.modeId),
    thinkingDisplay: seedDisplay(profile.thinkingOptionId),
    catalogResolution: "idle",
    controlsResolution: "idle",
    controlsPending: false,
    controlsRequest: null,
    controlsRequestKey: null,
    disclosure: {
      showModelField: false,
      showModeField: false,
      showThinkingField: false,
      showControlsField: false,
    },
    isDirty: false,
    draftRevision: 0,
    isSubmitting: false,
    submitError: null,
    canSubmit: false,
    submitValue: null,
  };
}

function pickMatchingId(
  preferred: string | null | undefined,
  options: readonly { id: string }[],
  fallback: string,
): string {
  const trimmed = preferred?.trim() ?? "";
  if (trimmed && options.some((option) => option.id === trimmed)) {
    return trimmed;
  }
  return fallback;
}

/**
 * Builds a ready-to-save profile in one tap (for composer model-row `+` creation).
 * Resolves defaults from the host catalog and preserves compatible composer mode/thinking
 * when provided, so the stored profile is concrete from the moment it is created.
 */
export function buildInstantAgentProfile(input: {
  seed: AgentProfileSeed;
  entries: readonly ProviderSnapshotEntry[] | undefined;
  preferredModeId?: string | null;
  preferredThinkingOptionId?: string | null;
}): AgentProfileValue {
  const entries = input.entries ?? [];
  const entry = findEntry(entries, input.seed.provider);
  const models = resolveModels(entries, input.seed.provider);
  const modes = resolveModes(entries, input.seed.provider);
  const modelId = input.seed.modelId?.trim() || defaultModelId(models);
  const effectiveModel = resolveEffectiveModel(models, modelId);
  const matchedModel = models.find((candidate) => candidate.id === modelId);
  const modeId = pickMatchingId(input.preferredModeId, modes, defaultModeId(entry, modes));
  const thinkingOptionId = pickMatchingId(
    input.preferredThinkingOptionId,
    effectiveModel?.thinkingOptions ?? [],
    defaultThinkingOptionId(effectiveModel),
  );
  const name =
    [input.seed.name?.trim(), matchedModel?.label, modelId, entry?.label, input.seed.provider].find(
      (candidate): candidate is string => Boolean(candidate),
    ) ?? input.seed.provider;

  return {
    name,
    provider: input.seed.provider,
    ...(modelId ? { model: modelId } : {}),
    ...(modeId ? { modeId } : {}),
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
    options: {},
  };
}

function resolveModeLabel(modes: readonly AgentMode[], modeId: string): string | null {
  const mode = modes.find((entry) => entry.id === modeId);
  return mode ? formatAgentModeLabel(mode) : null;
}

function resolveThinkingLabel(options: readonly AgentSelectOption[], id: string): string | null {
  const option = options.find((entry) => entry.id === id);
  return option ? formatThinkingOptionLabel(option) : null;
}

function resolveControlsSlice(input: {
  next: AgentProfileFormState;
  controlsRequestKey: string | null;
  controlsScopeKey: string | null;
  resolvedControlsKey: string | null;
  resolvedScopeKey: string | null;
  resolvedProvider: string | null;
  resolvedControls: AgentOptionControl[];
  resolvedOptions: ProviderOptions;
}): {
  controls: AgentOptionControl[];
  controlOptions: ProviderOptions;
  controlsResolution: AgentProfileResolutionStatus;
} {
  const featuresAreCurrent =
    input.controlsRequestKey !== null && input.controlsRequestKey === input.resolvedControlsKey;
  const controlsApply =
    input.controlsScopeKey !== null &&
    (input.controlsScopeKey === input.resolvedScopeKey ||
      (input.next.provider.length > 0 && input.next.provider === input.resolvedProvider));
  const controls = controlsApply ? input.resolvedControls : [];
  let controlOptions: ProviderOptions = input.next.options;
  if (controlsApply) {
    controlOptions = featuresAreCurrent
      ? input.resolvedOptions
      : { ...input.resolvedOptions, ...input.next.optionEdits };
  }
  return {
    controls,
    controlOptions,
    controlsResolution: resolveControlsStatus(input.controlsRequestKey, featuresAreCurrent),
  };
}

export function openAgentProfileForm(snapshot: AgentProfileFormSnapshot): AgentProfileFormModel {
  let entries: readonly ProviderSnapshotEntry[] = snapshot.entries ? [...snapshot.entries] : [];
  let catalogResolution: AgentProfileResolutionStatus = snapshot.entries ? "complete" : "idle";
  let resolvedControlsKey: string | null = null;
  let resolvedScopeKey: string | null = null;
  let resolvedProvider: string | null = null;
  let resolvedControls: AgentOptionControl[] = [];
  let resolvedOptions: ProviderOptions = {};
  let drawnKeys: ReadonlySet<string> = new Set();
  let answeredKeys: ReadonlySet<string> = new Set();
  let listeners = new Set<() => void>();
  let closed = false;
  let hasUserEdited = false;
  let draftRevision = 0;
  let baselineFingerprint = "";
  let autoSuggestedName: string | null =
    snapshot.mode === "create" ? (snapshot.seed?.name ?? null) : null;

  function derive(incoming: AgentProfileFormState): AgentProfileFormState {
    const models = resolveModels(entries, incoming.provider);
    const modes = resolveModes(entries, incoming.provider);
    const next: AgentProfileFormState = {
      ...seedSelections(incoming, {
        entry: findEntry(entries, incoming.provider),
        models,
        modes,
      }),
      drawnControlKeys: drawnKeys,
      answeredControlKeys: answeredKeys,
    };
    const thinking = resolveThinkingOptions(entries, next.provider, next.modelId);
    const controlsRequest = buildControlsRequest(next);
    const controlsRequestKey = buildControlsRequestKey(controlsRequest);
    const controlsScopeKey = buildControlsScopeKey(controlsRequest);
    const { controls, controlOptions, controlsResolution } = resolveControlsSlice({
      next,
      controlsRequestKey,
      controlsScopeKey,
      resolvedControlsKey,
      resolvedScopeKey,
      resolvedProvider,
      resolvedControls,
      resolvedOptions,
    });

    const withOptions: AgentProfileFormState = {
      ...next,
      providerOptions: buildProviderOptions(entries),
      unifiedModelOptions: buildUnifiedModelOptions(entries),
      modelOptions: buildModelOptions(models),
      modeOptions: buildModeOptions(modes),
      thinkingOptions: buildThinkingOptions(thinking),
      controls,
      controlOptions,
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
        resolveModeLabel(modes, next.modeId),
      ),
      thinkingDisplay: refineDisplay(
        next.thinkingDisplay,
        next.thinkingOptionId,
        resolveThinkingLabel(thinking, next.thinkingOptionId),
      ),
      catalogResolution,
      controlsResolution,
      controlsPending: controlsResolution === "pending",
      controlsRequest,
      controlsRequestKey,
    };

    // A field appears once the catalog can populate it, and stays visible while
    // a stored value needs a home even if this host cannot resolve it.
    const hasProvider = Boolean(withOptions.provider);
    const disclosure: AgentProfileFormDisclosure = {
      showModelField: hasProvider && (models.length > 0 || Boolean(withOptions.modelId)),
      showModeField: hasProvider && (modes.length > 0 || Boolean(withOptions.modeId)),
      showThinkingField:
        hasProvider && (thinking.length > 0 || Boolean(withOptions.thinkingOptionId)),
      showControlsField: hasProvider && controls.length > 0,
    };
    const canSubmit =
      withOptions.name.trim().length > 0 &&
      withOptions.provider.length > 0 &&
      !withOptions.isSubmitting;
    const resolved: AgentProfileFormState = { ...withOptions, disclosure, canSubmit };
    const submitValue = canSubmit ? buildSubmitValue(resolved) : null;
    const isDirty =
      baselineFingerprint.length > 0 && formDraftFingerprint(resolved) !== baselineFingerprint;
    return { ...resolved, isDirty, draftRevision, submitValue };
  }

  let state: AgentProfileFormState = derive(buildInitialState(snapshot));
  baselineFingerprint = formDraftFingerprint(state);

  function publish(
    mutate: (current: AgentProfileFormState) => AgentProfileFormState,
    options?: { userEdit?: boolean },
  ): void {
    if (closed) {
      return;
    }
    const previousFingerprint = formDraftFingerprint(state);
    if (options?.userEdit) {
      hasUserEdited = true;
    }
    let nextState = derive(mutate(state));
    if (options?.userEdit && formDraftFingerprint(nextState) !== previousFingerprint) {
      draftRevision += 1;
      nextState = { ...nextState, draftRevision };
    }
    // Catalog hydration fills in missing provider defaults (e.g., default mode on a
    // migrated favorite); refresh the clean baseline until the user makes an edit.
    if (!hasUserEdited) {
      baselineFingerprint = formDraftFingerprint(nextState);
      if (nextState.isDirty) {
        nextState = { ...nextState, isDirty: false };
      }
    }
    state = nextState;
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
    applyControls: (requestKey, resolved) => {
      if (requestKey !== state.controlsRequestKey) {
        return;
      }
      resolvedControlsKey = requestKey;
      resolvedScopeKey = buildControlsScopeKey(state.controlsRequest);
      resolvedProvider = state.provider || null;
      resolvedControls = [...resolved.controls];
      resolvedOptions = resolved.options;
      answeredKeys = new Set(resolved.controls.map((control) => control.key));
      drawnKeys = new Set([...drawnKeys, ...answeredKeys]);
      publish((current) => current);
    },
    applyControlsUnavailable: (requestKey) => {
      if (requestKey !== state.controlsRequestKey) {
        return;
      }
      resolvedControlsKey = requestKey;
      resolvedScopeKey = buildControlsScopeKey(state.controlsRequest);
      resolvedProvider = state.provider || null;
      resolvedControls = [];
      resolvedOptions = {};
      publish((current) => current);
    },
    setName: (value) =>
      publish(
        (current) => {
          if (value !== autoSuggestedName) {
            autoSuggestedName = null;
          }
          return { ...current, name: value };
        },
        { userEdit: true },
      ),
    setAppearance: (value) =>
      publish((current) => ({ ...current, icon: value.icon, color: value.color }), {
        userEdit: true,
      }),
    setSystemPrompt: (value) =>
      publish((current) => ({ ...current, systemPrompt: value }), { userEdit: true }),
    setNotes: (value) => publish((current) => ({ ...current, notes: value }), { userEdit: true }),
    setProvider: (providerId, display) =>
      publish(
        (current) => {
          if (current.provider === providerId) {
            return current;
          }
          // Everything below the provider is provider-scoped: a model id, mode id,
          // thinking id or feature id from the old provider means nothing here.
          // Clearing them is enough — `derive` seeds the new provider's defaults.
          drawnKeys = new Set();
          answeredKeys = new Set();
          resolvedProvider = null;
          resolvedScopeKey = null;
          resolvedControlsKey = null;
          resolvedControls = [];
          resolvedOptions = {};
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
            options: {},
            optionEdits: {},
          };
        },
        { userEdit: true },
      ),
    setProviderModel: (providerId, modelId, displays) =>
      publish(
        (current) => {
          const providerChanged = current.provider !== providerId;
          const modelChanged = current.modelId !== modelId;
          if (!providerChanged && !modelChanged) {
            return current;
          }
          const suggested = displays.model?.label ?? displays.provider.label;
          const shouldAutoName =
            current.mode === "create" &&
            (current.name.trim().length === 0 ||
              (autoSuggestedName !== null && current.name === autoSuggestedName));
          const nextName = shouldAutoName ? suggested : current.name;
          if (shouldAutoName) {
            autoSuggestedName = suggested;
          }
          if (providerChanged) {
            drawnKeys = new Set();
            answeredKeys = new Set();
            resolvedProvider = null;
            resolvedScopeKey = null;
            resolvedControlsKey = null;
            resolvedControls = [];
            resolvedOptions = {};
            return {
              ...current,
              name: nextName,
              provider: providerId,
              providerDisplay: displays.provider,
              modelId,
              modelDisplay: displays.model,
              modeId: "",
              modeDisplay: null,
              thinkingOptionId: "",
              thinkingDisplay: null,
              options: {},
              optionEdits: {},
            };
          }
          const nextThinking = resolveThinkingOptions(entries, current.provider, modelId);
          const keepsThinking =
            current.thinkingOptionId.length > 0 &&
            nextThinking.some((option) => option.id === current.thinkingOptionId);
          return {
            ...current,
            name: nextName,
            modelId,
            modelDisplay: displays.model,
            thinkingOptionId: keepsThinking ? current.thinkingOptionId : "",
            thinkingDisplay: keepsThinking ? current.thinkingDisplay : null,
          };
        },
        { userEdit: true },
      ),
    setModel: (modelId, display) =>
      publish(
        (current) => {
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
        },
        { userEdit: true },
      ),
    setMode: (modeId, display) =>
      publish((current) => ({ ...current, modeId, modeDisplay: display }), { userEdit: true }),
    setThinking: (thinkingOptionId, display) =>
      publish((current) => ({ ...current, thinkingOptionId, thinkingDisplay: display }), {
        userEdit: true,
      }),
    setOption: (key, value) =>
      publish(
        (current) => ({
          ...current,
          optionEdits: { ...current.optionEdits, [key]: value },
        }),
        { userEdit: true },
      ),
    setSubmitting: (value) => publish((current) => ({ ...current, isSubmitting: value })),
    setSubmitError: (value) => publish((current) => ({ ...current, submitError: value })),
  };
}
