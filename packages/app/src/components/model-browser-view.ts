import { compareMatchScores, scoreTextFields } from "@getpaseo/protocol/search/text-match";
import { getNextActiveIndex } from "@/components/ui/combobox-keyboard";
import {
  filterAndRankModelRows,
  getAllProviderModelRows,
  getProviderModelRows,
  type ProviderSelectionModelRow,
  type ProviderSelectorProvider,
} from "@/provider-selection/provider-selection";

export type ModelBrowserView =
  | { kind: "all" }
  | { kind: "provider"; providerId: string; providerLabel: string };

export function resolveModelBrowserScrolling({
  isNative,
  isCompact,
}: {
  isNative: boolean;
  isCompact: boolean;
}): "sheet" | "independent" {
  return isNative && isCompact ? "sheet" : "independent";
}

/** A profile's model reference; used to match profiles back to model rows. */
export interface ModelProfileRef {
  provider: string;
  modelId: string;
}

/**
 * Groups profiles by `provider:modelId`, skipping profiles that name no model.
 * Pure so the model browser can test it apart from the component tree.
 */
export function groupProfilesByProviderModel<T extends ModelProfileRef>(
  refs: readonly T[],
): Map<string, T[]> {
  const lookup = new Map<string, T[]>();
  for (const ref of refs) {
    const modelId = ref.modelId.trim();
    if (!modelId) {
      continue;
    }
    const key = `${ref.provider}:${modelId}`;
    const existing = lookup.get(key);
    if (existing) {
      existing.push(ref);
    } else {
      lookup.set(key, [ref]);
    }
  }
  return lookup;
}

/** What a profile row offers search: its name and its "Claude Code · Opus 5 · Plan" summary. */
export interface SearchableProfileRow {
  name: string;
  summary: string;
}

/** Profiles matching the query, best first. An empty query keeps every profile in order. */
export function filterAndRankProfileRows<T extends SearchableProfileRow>(
  rows: readonly T[],
  normalizedQuery: string,
): T[] {
  if (!normalizedQuery) return [...rows];
  return rows
    .map((row) => ({ row, score: scoreTextFields(normalizedQuery, [row.name, row.summary]) }))
    .filter((entry): entry is { row: T; score: NonNullable<typeof entry.score> } =>
      Boolean(entry.score),
    )
    .sort((a, b) => compareMatchScores(a.score, b.score) || a.row.name.localeCompare(b.row.name))
    .map((entry) => entry.row);
}

/** What the root view shows: the provider drill-down, or ranked cross-provider results. */
export type ModelBrowserAllView<T extends SearchableProfileRow> =
  | { kind: "browse" }
  | { kind: "searchResults"; profiles: T[]; rows: ProviderSelectionModelRow[] }
  | { kind: "noSearchMatches" };

export function resolveModelBrowserAllView<T extends SearchableProfileRow>({
  providers,
  profiles,
  normalizedQuery,
  isSearchFocused,
}: {
  providers: ProviderSelectorProvider[];
  /** Profiles the search may offer; empty when the surface shows none. */
  profiles: readonly T[];
  normalizedQuery: string;
  isSearchFocused: boolean;
}): ModelBrowserAllView<T> {
  if (!normalizedQuery && !isSearchFocused) {
    return { kind: "browse" };
  }
  const allRows = getAllProviderModelRows(providers);
  const rows = normalizedQuery ? filterAndRankModelRows(allRows, normalizedQuery) : allRows;
  const matchedProfiles = filterAndRankProfileRows(profiles, normalizedQuery);
  if (rows.length === 0 && matchedProfiles.length === 0) {
    return { kind: "noSearchMatches" };
  }
  return { kind: "searchResults", profiles: matchedProfiles, rows };
}

/** Where the picker lands when it opens. A sole provider skips the redundant root view. */
export function resolveInitialModelBrowserView({
  providers,
  selectedProvider,
  selectedModel,
  hasProfiles,
}: {
  providers: ProviderSelectorProvider[];
  selectedProvider: string;
  selectedModel: string;
  hasProfiles: boolean;
}): ModelBrowserView {
  const singleProvider = providers.length === 1 ? providers[0] : undefined;
  if (singleProvider) {
    return {
      kind: "provider",
      providerId: singleProvider.id,
      providerLabel: singleProvider.label,
    };
  }

  if (hasProfiles) {
    return { kind: "all" };
  }

  if (selectedProvider.length > 0 && selectedModel.length > 0) {
    const provider = providers.find((entry) => entry.id === selectedProvider);
    if (provider) {
      return { kind: "provider", providerId: provider.id, providerLabel: provider.label };
    }
  }

  return { kind: "all" };
}

export const MODEL_BROWSER_KEYBOARD_KEYS = [
  "ArrowDown",
  "ArrowUp",
  "ArrowRight",
  "ArrowLeft",
  "Backspace",
  "Enter",
] as const;

export const MODEL_BROWSER_CREATE_PROFILE_KEY = "create-profile";

export function modelBrowserProfileKey(profileId: string): string {
  return `profile:${profileId}`;
}

export function modelBrowserProviderKey(providerId: string): string {
  return `provider:${providerId}`;
}

export function modelBrowserModelKey(favoriteKey: string): string {
  return `model:${favoriteKey}`;
}

/** A profile row shape needed to build the ordered keyboard navigation list. */
export interface NavigableProfileRow extends SearchableProfileRow {
  id: string;
  provider: string;
}

export type ModelBrowserNavItem =
  | { key: string; kind: "profile"; profileId: string }
  | { key: typeof MODEL_BROWSER_CREATE_PROFILE_KEY; kind: "createProfile" }
  | { key: string; kind: "provider"; providerId: string; providerLabel: string }
  | { key: string; kind: "model"; provider: string; modelId: string; modelIndex: number };

export type ModelBrowserProfileSection<TProfile extends NavigableProfileRow = NavigableProfileRow> =
    | { kind: "none" }
    | { kind: "createProfile" }
    | { kind: "profiles"; rows: TProfile[] }
    | { kind: "searchProfiles"; rows: TProfile[]; showModelsHeading: boolean };

export type ModelBrowserProjection<TProfile extends NavigableProfileRow = NavigableProfileRow> =
  | { kind: "providerLoading"; navItems: ModelBrowserNavItem[] }
  | { kind: "providerError"; providerId: string; message: string; navItems: ModelBrowserNavItem[] }
  | { kind: "empty"; navItems: ModelBrowserNavItem[] }
  | { kind: "noSearchMatches"; navItems: ModelBrowserNavItem[] }
  | {
      kind: "modelList";
      profileSection: ModelBrowserProfileSection<TProfile>;
      modelRows: ProviderSelectionModelRow[];
      showProviderLabel: boolean;
      navItems: ModelBrowserNavItem[];
    }
  | {
      kind: "browse";
      profileSection: ModelBrowserProfileSection<TProfile>;
      providers: ProviderSelectorProvider[];
      showProvidersHeading: boolean;
      isEmpty: boolean;
      navItems: ModelBrowserNavItem[];
    };

export interface ModelBrowserProjectionInput<
  TProfile extends NavigableProfileRow = NavigableProfileRow,
> {
  view: ModelBrowserView;
  providers: ProviderSelectorProvider[];
  profiles: readonly TProfile[] | null;
  showProfilesSection: boolean;
  canCreateProfileRow: boolean;
  normalizedQuery: string;
  isSearchFocused: boolean;
  hasCustomRootBrowseContent: boolean;
}

function toProfileNavItems(rows: readonly NavigableProfileRow[]): ModelBrowserNavItem[] {
  return rows.map((row) => ({
    key: modelBrowserProfileKey(row.id),
    kind: "profile",
    profileId: row.id,
  }));
}

function profileSectionToNavItems<TProfile extends NavigableProfileRow>(
  section: ModelBrowserProfileSection<TProfile>,
): ModelBrowserNavItem[] {
  if (section.kind === "none") return [];
  if (section.kind === "createProfile") {
    return [{ key: MODEL_BROWSER_CREATE_PROFILE_KEY, kind: "createProfile" }];
  }
  return toProfileNavItems(section.rows);
}

function resolveBrowseProfileSection<TProfile extends NavigableProfileRow>(
  rows: readonly TProfile[] | null,
  showProfilesSection: boolean,
  canCreateProfileRow: boolean,
): ModelBrowserProfileSection<TProfile> {
  if (!showProfilesSection || rows === null) return { kind: "none" };
  if (rows.length > 0) return { kind: "profiles", rows: [...rows] };
  return canCreateProfileRow ? { kind: "createProfile" } : { kind: "none" };
}

function resolveProviderProfileSection<TProfile extends NavigableProfileRow>({
  providerProfiles,
  showProfilesSection,
  canCreateProfileRow,
  normalizedQuery,
  hasModelRows,
}: {
  providerProfiles: readonly TProfile[] | null;
  showProfilesSection: boolean;
  canCreateProfileRow: boolean;
  normalizedQuery: string;
  hasModelRows: boolean;
}): ModelBrowserProfileSection<TProfile> {
  if (!showProfilesSection || providerProfiles === null) return { kind: "none" };
  if (normalizedQuery.length === 0) {
    return resolveBrowseProfileSection(providerProfiles, true, canCreateProfileRow);
  }
  const matched = filterAndRankProfileRows(providerProfiles, normalizedQuery);
  return matched.length > 0
    ? { kind: "searchProfiles", rows: matched, showModelsHeading: hasModelRows }
    : { kind: "none" };
}

function toProviderNavItems(providers: readonly ProviderSelectorProvider[]): ModelBrowserNavItem[] {
  return providers.map((provider) => ({
    key: modelBrowserProviderKey(provider.id),
    kind: "provider",
    providerId: provider.id,
    providerLabel: provider.label,
  }));
}

function toModelNavItems(rows: readonly ProviderSelectionModelRow[]): ModelBrowserNavItem[] {
  return rows.map((row, modelIndex) => ({
    key: modelBrowserModelKey(row.favoriteKey),
    kind: "model",
    provider: row.provider,
    modelId: row.modelId,
    modelIndex,
  }));
}

function resolveProviderProjection<TProfile extends NavigableProfileRow>({
  providerId,
  providers,
  profiles,
  showProfilesSection,
  canCreateProfileRow,
  normalizedQuery,
}: {
  providerId: string;
  providers: ProviderSelectorProvider[];
  profiles: readonly TProfile[] | null;
  showProfilesSection: boolean;
  canCreateProfileRow: boolean;
  normalizedQuery: string;
}): ModelBrowserProjection<TProfile> {
  const provider = providers.find((entry) => entry.id === providerId) ?? null;
  if (!provider) return { kind: "empty", navItems: [] };
  if (provider.modelSelection.kind === "loading") return { kind: "providerLoading", navItems: [] };
  if (provider.modelSelection.kind === "error") {
    return {
      kind: "providerError",
      providerId,
      message: provider.modelSelection.message,
      navItems: [],
    };
  }

  const modelRows = filterAndRankModelRows(getProviderModelRows(provider), normalizedQuery);
  const providerProfiles =
    profiles !== null ? profiles.filter((row) => row.provider === providerId) : null;
  const profileSection = resolveProviderProfileSection({
    providerProfiles,
    showProfilesSection,
    canCreateProfileRow,
    normalizedQuery,
    hasModelRows: modelRows.length > 0,
  });

  if (modelRows.length === 0 && profileSection.kind === "none") {
    return { kind: "empty", navItems: [] };
  }

  return {
    kind: "modelList",
    profileSection,
    modelRows,
    showProviderLabel: false,
    navItems: [...profileSectionToNavItems(profileSection), ...toModelNavItems(modelRows)],
  };
}

/**
 * Single source of truth for what ModelBrowser renders and the flat keyboard navigation order.
 * Deriving navItems directly from the projected sections keeps rendering and arrow keys in lockstep.
 */
export function resolveModelBrowserProjection<TProfile extends NavigableProfileRow>(
  input: ModelBrowserProjectionInput<TProfile>,
): ModelBrowserProjection<TProfile> {
  if (input.view.kind === "provider") {
    return resolveProviderProjection({
      providerId: input.view.providerId,
      providers: input.providers,
      profiles: input.profiles,
      showProfilesSection: input.showProfilesSection,
      canCreateProfileRow: input.canCreateProfileRow,
      normalizedQuery: input.normalizedQuery,
    });
  }

  const allView = resolveModelBrowserAllView({
    providers: input.providers,
    profiles: input.showProfilesSection && input.profiles ? input.profiles : [],
    normalizedQuery: input.normalizedQuery,
    isSearchFocused: input.isSearchFocused,
  });

  if (allView.kind === "noSearchMatches") {
    return { kind: "noSearchMatches", navItems: [] };
  }

  if (allView.kind === "searchResults") {
    const profileSection: ModelBrowserProfileSection<TProfile> =
      allView.profiles.length > 0
        ? {
            kind: "searchProfiles",
            rows: allView.profiles,
            showModelsHeading: allView.rows.length > 0,
          }
        : { kind: "none" };
    return {
      kind: "modelList",
      profileSection,
      modelRows: allView.rows,
      showProviderLabel: true,
      navItems: [...profileSectionToNavItems(profileSection), ...toModelNavItems(allView.rows)],
    };
  }

  const profileSection = resolveBrowseProfileSection(
    input.profiles,
    input.showProfilesSection,
    input.canCreateProfileRow,
  );
  const visibleProviders = input.hasCustomRootBrowseContent ? [] : input.providers;
  const hasResults =
    input.profiles !== null || input.providers.length > 0 || input.hasCustomRootBrowseContent;

  return {
    kind: "browse",
    profileSection,
    providers: visibleProviders,
    showProvidersHeading: input.showProfilesSection && input.profiles !== null,
    isEmpty: !hasResults,
    navItems: [
      ...profileSectionToNavItems(profileSection),
      ...toProviderNavItems(visibleProviders),
    ],
  };
}

/**
 * Returns the flat visual order of keyboard-navigable rows for the current ModelBrowser state.
 */
export function resolveModelBrowserNavItems<TProfile extends NavigableProfileRow>(
  input: ModelBrowserProjectionInput<TProfile>,
): ModelBrowserNavItem[] {
  return resolveModelBrowserProjection(input).navItems;
}

export function resolveInitialModelBrowserActiveKey({
  items,
  view,
  normalizedQuery,
  selectedProvider,
  selectedModel,
  preferredKey,
}: {
  items: readonly ModelBrowserNavItem[];
  view: ModelBrowserView;
  normalizedQuery: string;
  selectedProvider: string;
  selectedModel: string;
  preferredKey?: string | null;
}): string | null {
  if (items.length === 0) return null;
  if (preferredKey && items.some((item) => item.key === preferredKey)) {
    return preferredKey;
  }
  if (normalizedQuery.length > 0) {
    return items[0].key;
  }
  if (view.kind === "provider" && selectedProvider.length > 0 && selectedModel.length > 0) {
    const selectedItem = items.find(
      (item) =>
        item.kind === "model" &&
        item.provider === selectedProvider &&
        item.modelId === selectedModel,
    );
    if (selectedItem) return selectedItem.key;
  }
  return items[0].key;
}

export function resolveActiveModelBrowserKey({
  explicitActiveKey,
  items,
  view,
  normalizedQuery,
  selectedProvider,
  selectedModel,
  preferredKey,
  suppressInitialActive = false,
}: {
  explicitActiveKey: string | null;
  items: readonly ModelBrowserNavItem[];
  view: ModelBrowserView;
  normalizedQuery: string;
  selectedProvider: string;
  selectedModel: string;
  preferredKey?: string | null;
  /** Skip initial highlight on native touch surfaces until the user navigates with a keyboard. */
  suppressInitialActive?: boolean;
}): string | null {
  if (explicitActiveKey && items.some((item) => item.key === explicitActiveKey)) {
    return explicitActiveKey;
  }
  if (suppressInitialActive) {
    return null;
  }
  return resolveInitialModelBrowserActiveKey({
    items,
    view,
    normalizedQuery,
    selectedProvider,
    selectedModel,
    preferredKey,
  });
}

export function moveModelBrowserActiveKey({
  items,
  activeKey,
  key,
}: {
  items: readonly ModelBrowserNavItem[];
  activeKey: string | null;
  key: "ArrowDown" | "ArrowUp";
}): string | null {
  if (items.length === 0) return null;
  const currentIndex = activeKey ? items.findIndex((item) => item.key === activeKey) : -1;
  const nextIndex = getNextActiveIndex({ currentIndex, itemCount: items.length, key });
  return nextIndex >= 0 ? (items[nextIndex]?.key ?? null) : null;
}

export type ModelBrowserKeyCommand =
  | { kind: "move"; nextKey: string }
  | { kind: "activate"; item: ModelBrowserNavItem }
  | { kind: "drillDown"; providerId: string; providerLabel: string }
  | { kind: "back"; providerId: string };

export interface ModelBrowserKeyEvent {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

function hasModifierKey(event: ModelBrowserKeyEvent): boolean {
  return Boolean(event.metaKey || event.ctrlKey || event.altKey);
}

function resolveHierarchyKeyCommand({
  key,
  view,
  activeItem,
  searchQuery,
  canGoBack,
}: {
  key: string;
  view: ModelBrowserView;
  activeItem: ModelBrowserNavItem | null;
  searchQuery: string;
  canGoBack: boolean;
}): ModelBrowserKeyCommand | null {
  if (searchQuery.length > 0) return null;

  if (key === "ArrowRight" && activeItem?.kind === "provider") {
    return {
      kind: "drillDown",
      providerId: activeItem.providerId,
      providerLabel: activeItem.providerLabel,
    };
  }

  if ((key === "ArrowLeft" || key === "Backspace") && view.kind === "provider" && canGoBack) {
    return { kind: "back", providerId: view.providerId };
  }

  return null;
}

/**
 * Resolves a keydown inside ModelBrowser into a navigation command, or null when the key
 * belongs to text editing or a focused secondary control.
 */
export function resolveModelBrowserKeyCommand({
  event,
  view,
  items,
  activeKey,
  searchQuery,
  canGoBack,
  focusedControlOwnsEnter,
}: {
  event: ModelBrowserKeyEvent;
  view: ModelBrowserView;
  items: readonly ModelBrowserNavItem[];
  activeKey: string | null;
  searchQuery: string;
  canGoBack: boolean;
  focusedControlOwnsEnter: boolean;
}): ModelBrowserKeyCommand | null {
  if (hasModifierKey(event)) return null;

  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    const nextKey = moveModelBrowserActiveKey({ items, activeKey, key: event.key });
    return nextKey ? { kind: "move", nextKey } : null;
  }

  if (event.shiftKey) return null;

  const activeItem = activeKey ? (items.find((item) => item.key === activeKey) ?? null) : null;

  if (event.key === "Enter") {
    return focusedControlOwnsEnter || !activeItem ? null : { kind: "activate", item: activeItem };
  }

  return resolveHierarchyKeyCommand({
    key: event.key,
    view,
    activeItem,
    searchQuery,
    canGoBack,
  });
}
