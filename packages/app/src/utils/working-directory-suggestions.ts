import { scoreMatch } from "./score-match";

export interface BuildWorkingDirectorySuggestionsInput {
  recommendedPaths: string[];
  serverPaths: string[];
  query: string;
}

export function buildWorkingDirectorySuggestions(
  input: BuildWorkingDirectorySuggestionsInput,
): string[] {
  const query = input.query.trim();
  const recommended = uniquePaths(input.recommendedPaths);
  if (!query) {
    return recommended;
  }

  const matchingRecommended = recommended.filter((path) =>
    recommendedPathMatchesQuery(path, query),
  );

  // The request owner correlates these results with the current query. The
  // daemon owns filesystem query parsing, filtering, and ranking; doing it
  // again here creates a second search implementation that can disagree.
  return uniquePaths([...matchingRecommended, ...input.serverPaths]);
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const path of paths) {
    const trimmed = path.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    ordered.push(trimmed);
  }
  return ordered;
}

function recommendedPathMatchesQuery(path: string, query: string): boolean {
  const candidate = normalizePath(path);
  const normalizedQuery = normalizePath(query);
  if (["~", "~/"].includes(normalizedQuery)) {
    return true;
  }
  if (normalizedQuery.includes("/") || normalizedQuery.startsWith("~")) {
    return false;
  }

  const basename = candidate.split("/").at(-1) ?? "";
  return candidate.includes(normalizedQuery) || scoreMatch(normalizedQuery, basename) !== null;
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, "/").toLowerCase();
}
