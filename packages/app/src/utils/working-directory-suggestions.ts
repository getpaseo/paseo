import { scoreMatch } from "./score-match";

export interface BuildWorkingDirectorySuggestionsInput {
  recommendedPaths: string[];
  serverPaths: string[];
  query: string;
}

export function buildWorkingDirectorySuggestions(
  input: BuildWorkingDirectorySuggestionsInput,
): string[] {
  const rawQuery = input.query.trim();
  const recommended = uniquePaths(input.recommendedPaths);
  if (!rawQuery) {
    return recommended;
  }

  const normalizedQuery = normalizeQuery(rawQuery);
  const isRootedPathQuery = isRootedQuery(rawQuery);
  const isAbsolutePathQuery = isAbsoluteQuery(rawQuery);
  const shouldFilterByQuery = normalizedQuery.length > 0;

  const recommendedMatches = shouldFilterByQuery
    ? recommended.filter((entry) =>
        pathMatchesQuery(entry, normalizedQuery, isRootedPathQuery, isAbsolutePathQuery),
      )
    : recommended;
  const seen = new Set(recommendedMatches);
  const ordered = [...recommendedMatches];

  for (const entry of uniquePaths(input.serverPaths)) {
    if (
      shouldFilterByQuery &&
      !pathMatchesQuery(entry, normalizedQuery, isRootedPathQuery, isAbsolutePathQuery)
    ) {
      continue;
    }
    if (seen.has(entry)) {
      continue;
    }
    ordered.push(entry);
    seen.add(entry);
  }

  return ordered;
}

function isRootedQuery(query: string): boolean {
  const normalized = query.trim().replace(/\\/g, "/");
  return normalized.startsWith("~") || normalized.startsWith("./") || isAbsoluteQuery(normalized);
}

function isAbsoluteQuery(query: string): boolean {
  const normalized = query.trim().replace(/\\/g, "/");
  return normalized.startsWith("/") || /^[a-z]:\//i.test(normalized);
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const pathEntry of paths) {
    const trimmed = pathEntry.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    ordered.push(trimmed);
  }
  return ordered;
}

function normalizeQuery(query: string): string {
  let normalized = query.trim();
  if (!normalized) {
    return "";
  }
  if (normalized.startsWith("~")) {
    normalized = normalized.slice(1);
  }
  normalized = normalized
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/")
    .toLowerCase();
  return normalized;
}

function pathMatchesQuery(
  candidatePath: string,
  query: string,
  isRootedPathQuery: boolean,
  isAbsolutePathQuery: boolean,
): boolean {
  const normalizedPath = candidatePath.replace(/\\/g, "/").toLowerCase();
  if (!isRootedPathQuery && normalizedPath.includes(query)) {
    return true;
  }

  const querySegments = query.split("/");
  const basenameQuery = querySegments.pop() ?? "";
  const parentQuery = querySegments.join("/");
  const candidateSegments = normalizedPath.split("/");
  const basename = candidateSegments.pop() ?? "";
  const parentPath = candidateSegments.join("/");
  const relativeParentPath = parentPath.replace(/^\/+/, "");
  if (isAbsolutePathQuery) {
    if (!isAbsoluteQuery(candidatePath) || relativeParentPath !== parentQuery) {
      return false;
    }
  } else if (parentQuery) {
    if (relativeParentPath !== parentQuery && !relativeParentPath.endsWith(`/${parentQuery}`)) {
      return false;
    }
  } else if (normalizedPath.includes(query)) {
    return true;
  }
  return scoreMatch(basenameQuery, basename) !== null;
}
