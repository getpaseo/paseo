import {
  createModelPickerState,
  MODEL_PICKER_PROFILES_RAIL_KEY,
  projectModelPicker,
  type ModelPickerInput,
  type ModelPickerListItem,
  type ModelPickerPane,
  type ModelPickerState,
} from "@/components/model-browser-panes-view";
import type { NavigableProfileRow } from "@/components/model-browser-view";
import { partitionProviderModels } from "@/provider-selection/model-curation";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";

/**
 * The compact model picker: Profiles (when the surface offers them) and one section per provider,
 * stacked as an accordion. At most one section is open at a time, and tapping the open section
 * collapses it so every group can sit closed. A query replaces the accordion with ranked results
 * across profiles and every provider, folded models included.
 *
 * It delegates to the desktop picker's projection so both form factors order, fold, rank and
 * search the same way.
 */

export interface MobileModelPageInput<TProfile extends NavigableProfileRow = NavigableProfileRow> {
  providers: readonly ProviderSelectorProvider[];
  /** `null` when the surface offers no profiles. */
  profiles: readonly TProfile[] | null;
  canCreateProfile: boolean;
  selectedProvider: string;
  selectedModel: string;
}

export interface MobileModelPageState {
  query: string;
  /** The open section (`MODEL_PICKER_PROFILES_RAIL_KEY` or a provider id), or `null` when all are collapsed. */
  expandedKey: string | null;
  /** Folds the user opened or closed, by provider. Others follow the partition's default. */
  foldOverrides: Readonly<Record<string, boolean>>;
}

export type MobileModelPageAction =
  | { kind: "query"; query: string }
  | { kind: "toggleSection"; key: string }
  | { kind: "toggleFold"; providerId: string; expanded: boolean };

export interface MobileProfilesSection {
  kind: "profiles";
  key: typeof MODEL_PICKER_PROFILES_RAIL_KEY;
  count: number;
  expanded: boolean;
}

export interface MobileProviderSection {
  kind: "provider";
  key: string;
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

export type MobileModelSection = MobileProfilesSection | MobileProviderSection;

export type MobileModelBody<TProfile extends NavigableProfileRow = NavigableProfileRow> = Extract<
  ModelPickerPane<TProfile>,
  { kind: "profiles" | "provider" | "providerLoading" | "providerError" }
>;

export type MobileModelPageProjection<TProfile extends NavigableProfileRow = NavigableProfileRow> =
  | {
      kind: "browse";
      sections: MobileModelSection[];
      /** False for a lone provider without profiles: its models are the page, with no header above them. */
      showSectionHeaders: boolean;
      /** What the open section lists, or `null` when every section is collapsed. */
      body: MobileModelBody<TProfile> | null;
      /** The selected model's row in the open list, which the list scrolls into view. */
      selectedIndex: number | null;
    }
  | {
      kind: "search";
      profiles: ModelPickerListItem<TProfile>[];
      models: ModelPickerListItem<TProfile>[];
      items: ModelPickerListItem<TProfile>[];
    }
  | { kind: "noMatches"; query: string }
  /** The host lists no providers, which is also the state before its first provider snapshot. */
  | { kind: "noProviders" };

export function createMobileModelPageState<TProfile extends NavigableProfileRow>(
  input: MobileModelPageInput<TProfile>,
): MobileModelPageState {
  return {
    query: "",
    expandedKey: createModelPickerState(toPickerInput(input)).railKey,
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
    case "toggleSection":
      return {
        ...state,
        expandedKey: state.expandedKey === action.key ? null : action.key,
      };
    case "toggleFold":
      return {
        ...state,
        foldOverrides: { ...state.foldOverrides, [action.providerId]: action.expanded },
      };
  }
}

export function projectMobileModelPage<TProfile extends NavigableProfileRow>(
  input: MobileModelPageInput<TProfile>,
  state: MobileModelPageState,
): MobileModelPageProjection<TProfile> {
  if (input.providers.length === 0) return { kind: "noProviders" };
  const picker = projectModelPicker<TProfile>(toPickerInput(input), toPickerState(state));
  const { pane } = picker;
  if (pane.kind === "noMatches") return { kind: "noMatches", query: pane.query };
  if (pane.kind === "search") {
    return { kind: "search", profiles: pane.profiles, models: pane.models, items: pane.items };
  }
  const sections: MobileModelSection[] = [];
  if (picker.layout === "twoPane") {
    for (const item of picker.rail) {
      if (item.kind === "profiles") {
        sections.push({
          kind: "profiles",
          key: item.key,
          count: item.count,
          expanded: false,
        });
      } else {
        const provider = input.providers.find((entry) => entry.id === item.providerId);
        if (provider) sections.push(toProviderSection(provider, false));
      }
    }
  } else {
    const provider = input.providers.find((entry) => entry.id === picker.railKey);
    if (provider) sections.push(toProviderSection(provider, true));
  }
  const showSectionHeaders = sections.length > 1;
  const expandedKey = showSectionHeaders && state.expandedKey === null ? null : picker.railKey;
  for (const section of sections) {
    section.expanded = section.key === expandedKey;
  }
  const body = expandedKey === null ? null : pane;
  return {
    kind: "browse",
    sections,
    showSectionHeaders,
    body,
    selectedIndex: body ? findSelectedIndex(body, input) : null,
  };
}

function findSelectedIndex<TProfile extends NavigableProfileRow>(
  body: MobileModelBody<TProfile>,
  input: MobileModelPageInput<TProfile>,
): number | null {
  if (body.kind !== "provider" || body.providerId !== input.selectedProvider) return null;
  const index = body.items.findIndex(
    (item) => item.kind === "model" && item.row.modelId === input.selectedModel,
  );
  return index >= 0 ? index : null;
}

function toPickerInput<TProfile extends NavigableProfileRow>(
  input: MobileModelPageInput<TProfile>,
): ModelPickerInput<TProfile> {
  return {
    providers: input.providers,
    profiles: input.profiles,
    canCreateProfile: input.canCreateProfile,
    selectedProvider: input.selectedProvider,
    selectedModel: input.selectedModel,
  };
}

function toPickerState(state: MobileModelPageState): ModelPickerState {
  return {
    query: state.query,
    railKey: state.expandedKey ?? "",
    focus: "list",
    activeKey: null,
    foldOverrides: state.foldOverrides,
  };
}

function toProviderSection(
  provider: ProviderSelectorProvider,
  expanded: boolean,
): MobileProviderSection {
  const base = {
    kind: "provider" as const,
    key: provider.id,
    providerId: provider.id,
    label: provider.label,
    expanded,
  };
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
