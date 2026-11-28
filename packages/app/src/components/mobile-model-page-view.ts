import {
  createModelPickerState,
  projectModelPicker,
  type ModelPickerInput,
  type ModelPickerListItem,
  type ModelPickerPane,
  type ModelPickerState,
} from "@/components/model-browser-panes-view";
import { partitionProviderModels } from "@/provider-selection/model-curation";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";

/**
 * The compact model picker: one section per provider, stacked. One provider is open at a time and
 * lists its models; the others are single rows above and below it. A query replaces the sections
 * with ranked results from every provider, folded models included.
 *
 * It is the desktop picker's projection with the open provider standing in for the selected rail
 * entry, so both form factors fold, rank and search the same way.
 */

export interface MobileModelPageInput {
  providers: readonly ProviderSelectorProvider[];
  selectedProvider: string;
  selectedModel: string;
}

export interface MobileModelPageState {
  query: string;
  expandedProviderId: string;
  /** Folds the user opened or closed, by provider. Others follow the partition's default. */
  foldOverrides: Readonly<Record<string, boolean>>;
}

export type MobileModelPageAction =
  | { kind: "query"; query: string }
  | { kind: "expand"; providerId: string }
  | { kind: "toggleFold"; providerId: string; expanded: boolean };

export interface MobileProviderSection {
  providerId: string;
  label: string;
  status: "ready" | "loading" | "error";
  /** Models listed before the fold. */
  shown: number;
  total: number;
  /** Some models sit behind a fold, so `shown` and `total` differ in meaning. */
  folds: boolean;
  expanded: boolean;
}

/** The page lists no profiles, so its items fit a list of any profile type. */
type NoProfile = never;

export type MobileModelItem = Extract<ModelPickerListItem<NoProfile>, { kind: "model" }>;
export type MobileModelBody = Extract<
  ModelPickerPane<NoProfile>,
  { kind: "provider" | "providerLoading" | "providerError" }
>;

export type MobileModelPageProjection =
  | {
      kind: "browse";
      sections: MobileProviderSection[];
      /** False for a lone provider: its models are the page, with no header above them. */
      showProviderHeaders: boolean;
      /** What the open section lists. */
      body: MobileModelBody;
      /** The selected model's row in the open list, which the list scrolls into view. */
      selectedIndex: number | null;
    }
  | { kind: "search"; items: MobileModelItem[] }
  | { kind: "noMatches"; query: string }
  /** The host lists no providers, which is also the state before its first provider snapshot. */
  | { kind: "noProviders" };

export function createMobileModelPageState(input: MobileModelPageInput): MobileModelPageState {
  return {
    query: "",
    expandedProviderId: createModelPickerState(toPickerInput(input)).railKey,
    foldOverrides: {},
  };
}

export function reduceMobileModelPage(
  state: MobileModelPageState,
  action: MobileModelPageAction,
): MobileModelPageState {
  switch (action.kind) {
    case "query":
      return { ...state, query: action.query };
    case "expand":
      return { ...state, expandedProviderId: action.providerId };
    case "toggleFold":
      return {
        ...state,
        foldOverrides: { ...state.foldOverrides, [action.providerId]: action.expanded },
      };
  }
}

export function projectMobileModelPage(
  input: MobileModelPageInput,
  state: MobileModelPageState,
): MobileModelPageProjection {
  if (input.providers.length === 0) return { kind: "noProviders" };
  const picker = projectModelPicker<NoProfile>(toPickerInput(input), toPickerState(state));
  const { pane } = picker;
  if (pane.kind === "noMatches") return { kind: "noMatches", query: pane.query };
  if (pane.kind === "search") {
    return { kind: "search", items: pane.models.filter(isModelItem) };
  }
  if (
    pane.kind !== "provider" &&
    pane.kind !== "providerLoading" &&
    pane.kind !== "providerError"
  ) {
    throw new Error(`A compact model page has no profiles pane, got ${pane.kind}`);
  }
  const providerIds =
    picker.layout === "twoPane"
      ? picker.rail.flatMap((item) => (item.kind === "provider" ? [item.providerId] : []))
      : [picker.railKey];
  const sections = providerIds.flatMap((providerId) => {
    const provider = input.providers.find((entry) => entry.id === providerId);
    return provider ? [toSection(provider, providerId === picker.railKey)] : [];
  });
  return {
    kind: "browse",
    sections,
    showProviderHeaders: input.providers.length > 1,
    body: pane,
    selectedIndex: findSelectedIndex(pane, input),
  };
}

function findSelectedIndex(body: MobileModelBody, input: MobileModelPageInput): number | null {
  if (body.kind !== "provider" || body.providerId !== input.selectedProvider) return null;
  const index = body.items.findIndex(
    (item) => item.kind === "model" && item.row.modelId === input.selectedModel,
  );
  return index >= 0 ? index : null;
}

function toPickerInput(input: MobileModelPageInput): ModelPickerInput<NoProfile> {
  return {
    providers: input.providers,
    profiles: null,
    canCreateProfile: false,
    selectedProvider: input.selectedProvider,
    selectedModel: input.selectedModel,
  };
}

function toPickerState(state: MobileModelPageState): ModelPickerState {
  return {
    query: state.query,
    railKey: state.expandedProviderId,
    focus: "list",
    activeKey: null,
    foldOverrides: state.foldOverrides,
  };
}

function toSection(provider: ProviderSelectorProvider, expanded: boolean): MobileProviderSection {
  const base = { providerId: provider.id, label: provider.label, expanded };
  const selection = provider.modelSelection;
  if (selection.kind !== "models") {
    return {
      ...base,
      status: selection.kind === "loading" ? "loading" : "error",
      shown: 0,
      total: 0,
      folds: false,
    };
  }
  const partition = partitionProviderModels(selection.rows, provider.shownModels, "");
  return {
    ...base,
    status: "ready",
    shown: partition.primary.length,
    total: selection.rows.length,
    folds: partition.foldKind !== null,
  };
}

function isModelItem(item: ModelPickerListItem<NoProfile>): item is MobileModelItem {
  return item.kind === "model";
}
