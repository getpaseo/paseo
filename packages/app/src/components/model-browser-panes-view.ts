import { getNextActiveIndex } from "@/components/ui/combobox-keyboard";
import {
  MODEL_BROWSER_CREATE_PROFILE_KEY,
  filterAndRankProfileRows,
  modelBrowserModelKey,
  modelBrowserProfileKey,
  type ModelBrowserKeyEvent,
  type NavigableProfileRow,
} from "@/components/model-browser-view";
import {
  partitionProviderModels,
  type ModelFoldKind,
  type ProviderModelPartition,
} from "@/provider-selection/model-curation";
import {
  filterAndRankModelRows,
  type ProviderSelectionModelRow,
  type ProviderSelectorProvider,
} from "@/provider-selection/provider-selection";

/**
 * The desktop model picker: a rail of Profiles and providers beside the open entry's list, or a
 * single list when there is only one provider to show. A query replaces both panes with ranked
 * results from every provider, folded models included.
 *
 * Everything the picker shows and every key it handles is derived here, so the view only renders
 * the projection and sends the user's actions back through `reduceModelPicker`.
 */

export const MODEL_PICKER_PROFILES_RAIL_KEY = "profiles";

const TWO_PANE_HEIGHT = 392;
const SINGLE_PANE_MIN_HEIGHT = 220;
const SINGLE_PANE_CHROME_HEIGHT = 96;
const LIST_ROW_HEIGHT = 36;

export type ModelPickerLayout = "twoPane" | "singlePane";
export type ModelPickerFocus = "rail" | "list";

export interface ModelPickerInput<TProfile extends NavigableProfileRow = NavigableProfileRow> {
  providers: readonly ProviderSelectorProvider[];
  /** `null` when the surface offers no profiles. */
  profiles: readonly TProfile[] | null;
  canCreateProfile: boolean;
  selectedProvider: string;
  selectedModel: string;
}

export interface ModelPickerState {
  query: string;
  /** The open rail entry: `MODEL_PICKER_PROFILES_RAIL_KEY` or a provider id. */
  railKey: string;
  focus: ModelPickerFocus;
  /** The row the user moved to. `null` falls back to the selected model or the first row. */
  activeKey: string | null;
  /** Folds the user opened or closed, by provider. Others follow the partition's default. */
  foldOverrides: Readonly<Record<string, boolean>>;
}

export type ModelPickerAction =
  | { kind: "query"; query: string }
  | { kind: "selectRail"; railKey: string }
  | { kind: "activate"; key: string }
  | { kind: "toggleFold"; providerId: string; expanded: boolean };

export type ModelPickerRailItem =
  | { kind: "profiles"; key: typeof MODEL_PICKER_PROFILES_RAIL_KEY; count: number }
  | {
      kind: "provider";
      key: string;
      providerId: string;
      label: string;
      status: "ready" | "loading" | "error";
      count: number;
      /** The first errored provider after ready ones; the rail draws a divider above it. */
      startsErrorGroup: boolean;
    };

export type ModelPickerListItem<TProfile extends NavigableProfileRow = NavigableProfileRow> =
  | {
      kind: "model";
      key: string;
      row: ProviderSelectionModelRow;
      /** Search only: the fold this model sits behind while browsing. */
      tag: ModelFoldKind;
    }
  | {
      kind: "fold";
      key: string;
      providerId: string;
      foldKind: "older" | "all";
      count: number;
      expanded: boolean;
    }
  | { kind: "profile"; key: string; profile: TProfile }
  | { kind: "createProfile"; key: typeof MODEL_BROWSER_CREATE_PROFILE_KEY };

export type ModelPickerPane<TProfile extends NavigableProfileRow = NavigableProfileRow> =
  | {
      kind: "provider";
      providerId: string;
      label: string;
      shown: number;
      total: number;
      foldKind: ModelFoldKind;
      items: ModelPickerListItem<TProfile>[];
    }
  | { kind: "providerLoading"; providerId: string; label: string; items: [] }
  | { kind: "providerError"; providerId: string; label: string; message: string; items: [] }
  | { kind: "profiles"; items: ModelPickerListItem<TProfile>[] }
  | {
      kind: "search";
      profiles: ModelPickerListItem<TProfile>[];
      models: ModelPickerListItem<TProfile>[];
      items: ModelPickerListItem<TProfile>[];
    }
  | { kind: "noMatches"; query: string; items: [] };

export interface ModelPickerProjection<TProfile extends NavigableProfileRow = NavigableProfileRow> {
  layout: ModelPickerLayout;
  rail: ModelPickerRailItem[];
  railKey: string;
  focus: ModelPickerFocus;
  pane: ModelPickerPane<TProfile>;
  /** The highlighted list row; `null` while the rail has focus. */
  activeKey: string | null;
}

export type ModelPickerKeyResult =
  | { kind: "state"; state: ModelPickerState }
  | { kind: "selectModel"; provider: string; modelId: string }
  | { kind: "applyProfile"; profileId: string }
  | { kind: "createProfile" }
  | null;

export function modelPickerFoldKey(providerId: string): string {
  return `fold:${providerId}`;
}

/** Two panes whenever there is a rail to choose from: several providers, or a surface that offers
 * profiles (even none yet, so the rail keeps the create-profile entry). */
export function resolveModelPickerLayout(input: ModelPickerInput): ModelPickerLayout {
  return input.providers.length > 1 || input.profiles !== null ? "twoPane" : "singlePane";
}

/**
 * The popover keeps one height for its whole life, so switching providers, opening a fold, or
 * searching never moves it. A single pane sizes to all its rows, folded ones included.
 */
export function resolveModelPickerHeight(input: ModelPickerInput): number {
  if (resolveModelPickerLayout(input) === "twoPane") return TWO_PANE_HEIGHT;
  const provider = input.providers[0];
  const rowCount = provider ? countAllRows(provider) : 0;
  return clamp(
    SINGLE_PANE_CHROME_HEIGHT + rowCount * LIST_ROW_HEIGHT,
    SINGLE_PANE_MIN_HEIGHT,
    TWO_PANE_HEIGHT,
  );
}

export function createModelPickerState(input: ModelPickerInput): ModelPickerState {
  return {
    query: "",
    railKey: resolveInitialRailKey(input),
    focus: "list",
    activeKey: null,
    foldOverrides: {},
  };
}

export function reduceModelPicker(
  state: ModelPickerState,
  action: ModelPickerAction,
): ModelPickerState {
  switch (action.kind) {
    case "query":
      return { ...state, query: action.query, activeKey: null };
    case "selectRail":
      return { ...state, railKey: action.railKey, activeKey: null };
    case "activate":
      return { ...state, activeKey: action.key, focus: "list" };
    case "toggleFold":
      return {
        ...state,
        foldOverrides: { ...state.foldOverrides, [action.providerId]: action.expanded },
      };
  }
}

export function projectModelPicker<TProfile extends NavigableProfileRow>(
  input: ModelPickerInput<TProfile>,
  state: ModelPickerState,
): ModelPickerProjection<TProfile> {
  const layout = resolveModelPickerLayout(input);
  const rail = layout === "twoPane" ? buildRail(input) : [];
  const railKey = resolveRailKey(input, state, layout, rail);
  const normalizedQuery = normalizeQuery(state.query);
  const pane = normalizedQuery
    ? buildSearchPane(input, normalizedQuery, state.query.trim())
    : buildBrowsePane(input, state, railKey);
  const focus: ModelPickerFocus =
    layout === "twoPane" && !normalizedQuery && state.focus === "rail" ? "rail" : "list";
  return {
    layout,
    rail,
    railKey,
    focus,
    pane,
    activeKey: focus === "list" ? resolveActiveKey(input, state, pane) : null,
  };
}

/**
 * Resolves a keydown into the next state or a pick, or `null` when the key belongs to text editing,
 * a focused button, or the host (an unclaimed Escape closes the picker).
 */
export function resolveModelPickerKey<TProfile extends NavigableProfileRow>(
  input: ModelPickerInput<TProfile>,
  state: ModelPickerState,
  options: { event: ModelBrowserKeyEvent; focusedControlOwnsEnter: boolean },
): ModelPickerKeyResult {
  const { event } = options;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  const projection = projectModelPicker(input, state);

  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    return moveActive(projection, state, event.key);
  }
  if (event.shiftKey) return null;

  if (event.key === "Escape") {
    return state.query.length > 0
      ? { kind: "state", state: reduceModelPicker(state, { kind: "query", query: "" }) }
      : null;
  }

  if (event.key === "Enter") {
    if (options.focusedControlOwnsEnter) return null;
    if (projection.focus === "rail") return enterList(projection, state);
    return activateItem(projection, state);
  }

  const browsingTwoPanes = projection.layout === "twoPane" && state.query.trim().length === 0;
  if (!browsingTwoPanes) return null;
  if (event.key === "ArrowRight" && projection.focus === "rail") {
    return enterList(projection, state);
  }
  if (event.key === "ArrowLeft" && projection.focus === "list") {
    return { kind: "state", state: { ...state, focus: "rail", activeKey: null } };
  }
  return null;
}

function moveActive(
  projection: ModelPickerProjection,
  state: ModelPickerState,
  key: "ArrowDown" | "ArrowUp",
): ModelPickerKeyResult {
  if (projection.focus === "rail") {
    const nextKey = stepKey(
      projection.rail.map((item) => item.key),
      projection.railKey,
      key,
    );
    return nextKey
      ? { kind: "state", state: reduceModelPicker(state, { kind: "selectRail", railKey: nextKey }) }
      : null;
  }
  const nextKey = stepKey(
    projection.pane.items.map((item) => item.key),
    projection.activeKey,
    key,
  );
  return nextKey
    ? { kind: "state", state: reduceModelPicker(state, { kind: "activate", key: nextKey }) }
    : null;
}

function enterList(
  projection: ModelPickerProjection,
  state: ModelPickerState,
): ModelPickerKeyResult {
  if (projection.pane.items.length === 0) return null;
  return { kind: "state", state: { ...state, focus: "list", activeKey: null } };
}

function activateItem(
  projection: ModelPickerProjection,
  state: ModelPickerState,
): ModelPickerKeyResult {
  const item = projection.pane.items.find((entry) => entry.key === projection.activeKey);
  if (!item) return null;
  switch (item.kind) {
    case "model":
      return { kind: "selectModel", provider: item.row.provider, modelId: item.row.modelId };
    case "profile":
      return { kind: "applyProfile", profileId: item.profile.id };
    case "createProfile":
      return { kind: "createProfile" };
    case "fold":
      return {
        kind: "state",
        state: reduceModelPicker(
          { ...state, activeKey: item.key },
          { kind: "toggleFold", providerId: item.providerId, expanded: !item.expanded },
        ),
      };
  }
}

function stepKey(
  keys: readonly string[],
  currentKey: string | null,
  key: "ArrowDown" | "ArrowUp",
): string | null {
  const currentIndex = currentKey ? keys.indexOf(currentKey) : -1;
  const nextIndex = getNextActiveIndex({ currentIndex, itemCount: keys.length, key });
  return nextIndex >= 0 ? (keys[nextIndex] ?? null) : null;
}

function resolveActiveKey(
  input: ModelPickerInput,
  state: ModelPickerState,
  pane: ModelPickerPane,
): string | null {
  const { items } = pane;
  if (items.length === 0) return null;
  if (state.activeKey && items.some((item) => item.key === state.activeKey)) {
    return state.activeKey;
  }
  if (pane.kind === "provider") {
    const selectedKey = modelBrowserModelKey(`${input.selectedProvider}:${input.selectedModel}`);
    if (items.some((item) => item.key === selectedKey)) return selectedKey;
  }
  return items[0].key;
}

function resolveInitialRailKey(input: ModelPickerInput): string {
  const selected = input.providers.find((provider) => provider.id === input.selectedProvider);
  if (selected) return selected.id;
  if (resolveModelPickerLayout(input) === "twoPane" && (input.profiles?.length ?? 0) > 0) {
    return MODEL_PICKER_PROFILES_RAIL_KEY;
  }
  const ready = input.providers.find((provider) => provider.modelSelection.kind === "models");
  return (ready ?? input.providers[0])?.id ?? MODEL_PICKER_PROFILES_RAIL_KEY;
}

function resolveRailKey(
  input: ModelPickerInput,
  state: ModelPickerState,
  layout: ModelPickerLayout,
  rail: readonly ModelPickerRailItem[],
): string {
  if (layout === "singlePane") return input.providers[0]?.id ?? MODEL_PICKER_PROFILES_RAIL_KEY;
  if (rail.some((item) => item.key === state.railKey)) return state.railKey;
  return rail[0]?.key ?? MODEL_PICKER_PROFILES_RAIL_KEY;
}

function buildRail(input: ModelPickerInput): ModelPickerRailItem[] {
  const providerItems = input.providers.map((provider) => buildProviderRailItem(input, provider));
  const working = providerItems.filter((item) => item.status !== "error");
  const errored = providerItems.filter((item) => item.status === "error");
  const firstErrored = errored[0];
  if (firstErrored && working.length > 0) firstErrored.startsErrorGroup = true;
  const ordered = [...working, ...errored];
  if (input.profiles === null) return ordered;
  return [
    { kind: "profiles", key: MODEL_PICKER_PROFILES_RAIL_KEY, count: input.profiles.length },
    ...ordered,
  ];
}

function buildProviderRailItem(
  input: ModelPickerInput,
  provider: ProviderSelectorProvider,
): Extract<ModelPickerRailItem, { kind: "provider" }> {
  const selection = provider.modelSelection;
  const base = {
    kind: "provider" as const,
    key: provider.id,
    providerId: provider.id,
    label: provider.label,
    startsErrorGroup: false,
  };
  if (selection.kind === "loading") return { ...base, status: "loading", count: 0 };
  if (selection.kind === "error") return { ...base, status: "error", count: 0 };
  return { ...base, status: "ready", count: partitionFor(input, provider).primary.length };
}

function buildBrowsePane<TProfile extends NavigableProfileRow>(
  input: ModelPickerInput<TProfile>,
  state: ModelPickerState,
  railKey: string,
): ModelPickerPane<TProfile> {
  if (railKey === MODEL_PICKER_PROFILES_RAIL_KEY) {
    return { kind: "profiles", items: buildProfileItems(input) };
  }
  const provider = input.providers.find((entry) => entry.id === railKey);
  if (!provider) return { kind: "profiles", items: buildProfileItems(input) };
  const selection = provider.modelSelection;
  if (selection.kind === "loading") {
    return { kind: "providerLoading", providerId: provider.id, label: provider.label, items: [] };
  }
  if (selection.kind === "error") {
    return {
      kind: "providerError",
      providerId: provider.id,
      label: provider.label,
      message: selection.message,
      items: [],
    };
  }
  const partition = partitionFor(input, provider);
  return {
    kind: "provider",
    providerId: provider.id,
    label: provider.label,
    shown: partition.primary.length,
    total: selection.rows.length,
    foldKind: partition.foldKind,
    items: buildProviderItems(provider.id, partition, state),
  };
}

function buildProviderItems<TProfile extends NavigableProfileRow>(
  providerId: string,
  partition: ProviderModelPartition,
  state: ModelPickerState,
): ModelPickerListItem<TProfile>[] {
  const primary = partition.primary.map((row) => toModelItem<TProfile>(row, null));
  if (partition.foldKind === null) return primary;
  const expanded = state.foldOverrides[providerId] ?? partition.defaultExpanded;
  const fold: ModelPickerListItem<TProfile> = {
    kind: "fold",
    key: modelPickerFoldKey(providerId),
    providerId,
    foldKind: partition.foldKind,
    count: partition.folded.length,
    expanded,
  };
  const folded = expanded ? partition.folded.map((row) => toModelItem<TProfile>(row, null)) : [];
  return [...primary, fold, ...folded];
}

function buildProfileItems<TProfile extends NavigableProfileRow>(
  input: ModelPickerInput<TProfile>,
): ModelPickerListItem<TProfile>[] {
  const profiles = input.profiles ?? [];
  if (profiles.length === 0) {
    return input.canCreateProfile
      ? [{ kind: "createProfile", key: MODEL_BROWSER_CREATE_PROFILE_KEY }]
      : [];
  }
  return profiles.map((profile) => toProfileItem(profile));
}

function buildSearchPane<TProfile extends NavigableProfileRow>(
  input: ModelPickerInput<TProfile>,
  normalizedQuery: string,
  displayQuery: string,
): ModelPickerPane<TProfile> {
  const profiles = filterAndRankProfileRows(input.profiles ?? [], normalizedQuery).map((profile) =>
    toProfileItem(profile),
  );
  const foldedBy = new Map<string, ModelFoldKind>();
  const primaryRows: ProviderSelectionModelRow[] = [];
  const foldedRows: ProviderSelectionModelRow[] = [];
  for (const provider of input.providers) {
    if (provider.modelSelection.kind !== "models") continue;
    const partition = partitionFor(input, provider);
    primaryRows.push(...partition.primary);
    foldedRows.push(...partition.folded);
    for (const row of partition.folded) foldedBy.set(row.favoriteKey, partition.foldKind);
  }
  // Primary models outrank folded ones, so "opus" leads with the current Opus while "4.6" still
  // reaches the older one directly.
  const models = [
    ...filterAndRankModelRows(primaryRows, normalizedQuery),
    ...filterAndRankModelRows(foldedRows, normalizedQuery),
  ].map((row) => toModelItem<TProfile>(row, foldedBy.get(row.favoriteKey) ?? null));
  if (profiles.length === 0 && models.length === 0) {
    return { kind: "noMatches", query: displayQuery, items: [] };
  }
  return { kind: "search", profiles, models, items: [...profiles, ...models] };
}

function partitionFor(
  input: ModelPickerInput,
  provider: ProviderSelectorProvider,
): ProviderModelPartition {
  const rows = provider.modelSelection.kind === "models" ? provider.modelSelection.rows : [];
  const selectedModel = provider.id === input.selectedProvider ? input.selectedModel : "";
  return partitionProviderModels(rows, provider.shownModels, selectedModel);
}

function countAllRows(provider: ProviderSelectorProvider): number {
  if (provider.modelSelection.kind !== "models") return 0;
  const partition = partitionProviderModels(provider.modelSelection.rows, provider.shownModels, "");
  const foldRow = partition.foldKind === null ? 0 : 1;
  return provider.modelSelection.rows.length + foldRow;
}

function toModelItem<TProfile extends NavigableProfileRow>(
  row: ProviderSelectionModelRow,
  tag: ModelFoldKind,
): ModelPickerListItem<TProfile> {
  return { kind: "model", key: modelBrowserModelKey(row.favoriteKey), row, tag };
}

function toProfileItem<TProfile extends NavigableProfileRow>(
  profile: TProfile,
): ModelPickerListItem<TProfile> {
  return { kind: "profile", key: modelBrowserProfileKey(profile.id), profile };
}

function normalizeQuery(value: string): string {
  return value.trim().toLowerCase();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
