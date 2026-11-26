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

function toProfileNavItems(rows: readonly NavigableProfileRow[]): ModelBrowserNavItem[] {
  return rows.map((row) => ({
    key: modelBrowserProfileKey(row.id),
    kind: "profile",
    profileId: row.id,
  }));
}

function toBrowseProfileNavItems(
  rows: readonly NavigableProfileRow[] | null,
  showProfilesSection: boolean,
  canCreateProfileRow: boolean,
): ModelBrowserNavItem[] {
  if (!showProfilesSection || rows === null) return [];
  if (rows.length > 0) return toProfileNavItems(rows);
  return canCreateProfileRow
    ? [{ key: MODEL_BROWSER_CREATE_PROFILE_KEY, kind: "createProfile" }]
    : [];
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

function resolveProviderNavItems({
  providerId,
  providers,
  profiles,
  showProfilesSection,
  canCreateProfileRow,
  normalizedQuery,
}: {
  providerId: string;
  providers: ProviderSelectorProvider[];
  profiles: readonly NavigableProfileRow[] | null;
  showProfilesSection: boolean;
  canCreateProfileRow: boolean;
  normalizedQuery: string;
}): ModelBrowserNavItem[] {
  const provider = providers.find((entry) => entry.id === providerId) ?? null;
  if (!provider || provider.modelSelection.kind !== "models") return [];

  const providerProfiles =
    profiles !== null ? profiles.filter((row) => row.provider === providerId) : null;
  let profileItems: ModelBrowserNavItem[] = [];
  if (normalizedQuery.length === 0) {
    profileItems = toBrowseProfileNavItems(
      providerProfiles,
      showProfilesSection,
      canCreateProfileRow,
    );
  } else if (showProfilesSection && providerProfiles) {
    profileItems = toProfileNavItems(filterAndRankProfileRows(providerProfiles, normalizedQuery));
  }

  const visibleModels = filterAndRankModelRows(getProviderModelRows(provider), normalizedQuery);
  return [...profileItems, ...toModelNavItems(visibleModels)];
}

/**
 * Builds the flat visual order of keyboard-navigable rows for the current ModelBrowser state.
 * Mirrors the exact top-to-bottom layout across profiles, providers, and models.
 */
export function resolveModelBrowserNavItems({
  view,
  providers,
  profiles,
  showProfilesSection,
  canCreateProfileRow,
  normalizedQuery,
  isSearchFocused,
  hasCustomRootBrowseContent,
}: {
  view: ModelBrowserView;
  providers: ProviderSelectorProvider[];
  profiles: readonly NavigableProfileRow[] | null;
  showProfilesSection: boolean;
  canCreateProfileRow: boolean;
  normalizedQuery: string;
  isSearchFocused: boolean;
  hasCustomRootBrowseContent: boolean;
}): ModelBrowserNavItem[] {
  if (view.kind === "provider") {
    return resolveProviderNavItems({
      providerId: view.providerId,
      providers,
      profiles,
      showProfilesSection,
      canCreateProfileRow,
      normalizedQuery,
    });
  }

  const allView = resolveModelBrowserAllView({
    providers,
    profiles: showProfilesSection && profiles ? profiles : [],
    normalizedQuery,
    isSearchFocused,
  });

  if (allView.kind === "noSearchMatches") return [];

  if (allView.kind === "searchResults") {
    return [...toProfileNavItems(allView.profiles), ...toModelNavItems(allView.rows)];
  }

  const profileItems = toBrowseProfileNavItems(profiles, showProfilesSection, canCreateProfileRow);
  if (hasCustomRootBrowseContent) return profileItems;

  const providerItems: ModelBrowserNavItem[] = providers.map((provider) => ({
    key: modelBrowserProviderKey(provider.id),
    kind: "provider",
    providerId: provider.id,
    providerLabel: provider.label,
  }));
  return [...profileItems, ...providerItems];
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
}: {
  explicitActiveKey: string | null;
  items: readonly ModelBrowserNavItem[];
  view: ModelBrowserView;
  normalizedQuery: string;
  selectedProvider: string;
  selectedModel: string;
  preferredKey?: string | null;
}): string | null {
  if (explicitActiveKey && items.some((item) => item.key === explicitActiveKey)) {
    return explicitActiveKey;
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
