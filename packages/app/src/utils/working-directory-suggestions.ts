import { scorePathMatch } from "@getpaseo/protocol/search/text-match";
import { shortenPath } from "@/utils/shorten-path";

export interface BuildWorkingDirectorySuggestionsInput {
  recommendedPaths: string[];
  serverPaths: string[];
  query: string;
}

export function normalizeDirectoryQuery(query: string): string {
  const trimmed = query.trim();
  if (trimmed === "\uFF5E" || trimmed.startsWith("\uFF5E/") || trimmed.startsWith("\uFF5E\\")) {
    return `~${trimmed.slice(1)}`;
  }
  return trimmed;
}

export function buildWorkingDirectorySuggestions(
  input: BuildWorkingDirectorySuggestionsInput,
): string[] {
  const query = normalizeDirectoryQuery(input.query);
  const recommended = uniquePaths(input.recommendedPaths);
  if (!query) {
    return recommended;
  }

  const matchingRecommended = recommended.filter((path) => pathMatchesDirectoryQuery(path, query));

  // Server paths are already ranked by the daemon. Recommended paths use the
  // same shared matcher, then keep their existing recommendation order.
  return uniquePaths([...matchingRecommended, ...input.serverPaths]);
}

export function filterDirectoryPathsByQuery(paths: string[], query: string): string[] {
  const normalizedQuery = normalizeDirectoryQuery(query);
  if (!normalizedQuery) return [];
  return paths.filter((path) => pathMatchesDirectoryQuery(path, normalizedQuery));
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

function pathMatchesDirectoryQuery(path: string, query: string): boolean {
  const candidate = normalizePath(path);
  const normalizedQuery = normalizePath(normalizeDirectoryQuery(query));
  if (["~", "~/"].includes(normalizedQuery)) {
    return true;
  }
  if (normalizedQuery.startsWith("~/")) {
    const shortened = normalizePath(shortenPath(path));
    if (shortened.startsWith("~/") && scorePathMatch(normalizedQuery, shortened) !== null) {
      return true;
    }
  }

  return scorePathMatch(normalizedQuery, candidate) !== null;
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, "/").toLowerCase();
}
