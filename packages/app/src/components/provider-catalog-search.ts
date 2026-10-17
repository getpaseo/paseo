import {
  compareMatchScores,
  scoreTextFields,
  type MatchScore,
} from "@getpaseo/protocol/search/text-match";

export interface SearchableCatalogEntry {
  id: string;
  title: string;
}

function compareTitles(a: SearchableCatalogEntry, b: SearchableCatalogEntry): number {
  return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
}

/**
 * Orders the Add provider catalog. Without a query the list is alphabetical by
 * name. With a query it uses the pickers' ranked matcher over the fields the
 * tile shows (name and id), best match first, ties alphabetical.
 */
export function rankProviderCatalog<T extends SearchableCatalogEntry>(
  entries: readonly T[],
  query: string,
): T[] {
  if (!query.trim()) return [...entries].sort(compareTitles);

  const scored: { entry: T; score: MatchScore }[] = [];
  for (const entry of entries) {
    const score = scoreTextFields(query, [entry.title, entry.id]);
    if (score) scored.push({ entry, score });
  }
  scored.sort((a, b) => compareMatchScores(a.score, b.score) || compareTitles(a.entry, b.entry));
  return scored.map(({ entry }) => entry);
}
