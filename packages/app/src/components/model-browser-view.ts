import { compareMatchScores, scoreTextFields } from "@getpaseo/protocol/search/text-match";
import {
  filterAndRankModelRows,
  getAllProviderModelRows,
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
