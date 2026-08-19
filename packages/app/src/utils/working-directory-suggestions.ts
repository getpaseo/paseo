import { scorePathMatch } from "@getpaseo/protocol/search/text-match";

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

  // Server paths are already ranked by the daemon. Recommended paths use the
  // same shared matcher, then keep their existing recommendation order.
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

  return scorePathMatch(normalizedQuery, candidate) !== null;
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, "/").toLowerCase();
}
