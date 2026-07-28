import {
  filterAndRankModelRows,
  getAllProviderModelRows,
  getProviderModelRows,
  type ProviderSelectionModelRow,
  type ProviderSelectorProvider,
} from "@/provider-selection/provider-selection";

export type ModelBrowserHeadingStatus = "loading" | "error";

export type ModelBrowserListItem =
  | {
      kind: "heading";
      key: string;
      label: string;
      status?: ModelBrowserHeadingStatus;
      /** Set on provider group headings so a failed one can drill in to retry. */
      providerId?: string;
    }
  | {
      kind: "model";
      key: string;
      row: ProviderSelectionModelRow;
      showProvider: boolean;
    };

export function normalizeModelSearchQuery(value: string): string {
  return value.trim().toLowerCase();
}

export function sortFavoritesFirst(
  rows: ProviderSelectionModelRow[],
  favoriteKeys: Set<string>,
): ProviderSelectionModelRow[] {
  const favorites: ProviderSelectionModelRow[] = [];
  const rest: ProviderSelectionModelRow[] = [];
  for (const row of rows) {
    if (favoriteKeys.has(row.favoriteKey)) {
      favorites.push(row);
    } else {
      rest.push(row);
    }
  }
  return [...favorites, ...rest];
}

export function buildModelRowDescription(
  row: ProviderSelectionModelRow,
  showProvider: boolean,
): string | undefined {
  if (!showProvider) return row.description;
  return row.description ? `${row.providerLabel} · ${row.description}` : row.providerLabel;
}

export function countAllModels(providers: ProviderSelectorProvider[]): number {
  return getAllProviderModelRows(providers).length;
}

function toModelItem(
  row: ProviderSelectionModelRow,
  prefix: string,
  showProvider: boolean,
): ModelBrowserListItem {
  return { kind: "model", key: `${prefix}:${row.favoriteKey}`, row, showProvider };
}

function resolveHeadingStatus(
  provider: ProviderSelectorProvider,
): ModelBrowserHeadingStatus | undefined {
  if (provider.modelSelection.kind === "loading") return "loading";
  if (provider.modelSelection.kind === "error") return "error";
  return undefined;
}

export function buildProviderModelListItems({
  provider,
  favoriteKeys,
  normalizedQuery,
}: {
  provider: ProviderSelectorProvider;
  favoriteKeys: Set<string>;
  normalizedQuery: string;
}): ModelBrowserListItem[] {
  const rows = getProviderModelRows(provider);
  const displayRows = normalizedQuery
    ? filterAndRankModelRows(rows, normalizedQuery)
    : sortFavoritesFirst(rows, favoriteKeys);
  return displayRows.map((row) => toModelItem(row, "model", false));
}

/**
 * The cross-provider catalog: favorites first, then one group per provider.
 * A query collapses the groups into a single ranked run so a match in the last
 * provider is not buried below every earlier provider's models.
 */
export function buildAllModelsListItems({
  providers,
  favoriteKeys,
  favoritesLabel,
  normalizedQuery,
}: {
  providers: ProviderSelectorProvider[];
  favoriteKeys: Set<string>;
  favoritesLabel: string;
  normalizedQuery: string;
}): ModelBrowserListItem[] {
  if (normalizedQuery) {
    return filterAndRankModelRows(getAllProviderModelRows(providers), normalizedQuery).map((row) =>
      toModelItem(row, "model", true),
    );
  }

  const items: ModelBrowserListItem[] = [];
  const favoriteRows = getAllProviderModelRows(providers).filter((row) =>
    favoriteKeys.has(row.favoriteKey),
  );
  if (favoriteRows.length > 0) {
    items.push({ kind: "heading", key: "heading:favorites", label: favoritesLabel });
    for (const row of favoriteRows) {
      items.push(toModelItem(row, "favorite", true));
    }
  }

  for (const provider of providers) {
    const status = resolveHeadingStatus(provider);
    const rows = getProviderModelRows(provider);
    if (!status && rows.length === 0) continue;
    items.push({
      kind: "heading",
      key: `heading:provider:${provider.id}`,
      label: provider.label,
      providerId: provider.id,
      ...(status ? { status } : {}),
    });
    for (const row of rows) {
      items.push(toModelItem(row, "model", false));
    }
  }

  return items;
}
