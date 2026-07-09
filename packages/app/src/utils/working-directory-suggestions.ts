import { scoreMatch } from "./score-match";

export interface BuildWorkingDirectorySuggestionsInput {
  recommendedPaths: string[];
  serverPaths: string[];
  query: string;
}

interface PathQueryMode {
  absolute: boolean;
  rootAnchored: boolean;
  rooted: boolean;
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
  const queryMode = getPathQueryMode(rawQuery);
  const shouldFilterByQuery = normalizedQuery.length > 0;

  const recommendedMatches = shouldFilterByQuery
    ? recommended.filter((entry) => pathMatchesQuery(entry, normalizedQuery, queryMode))
    : recommended;
  const seen = new Set(recommendedMatches);
  const ordered = [...recommendedMatches];

  for (const entry of uniquePaths(input.serverPaths)) {
    if (shouldFilterByQuery && !pathMatchesQuery(entry, normalizedQuery, queryMode)) {
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

function getPathQueryMode(query: string): PathQueryMode {
  const normalized = query.trim().replace(/\\/g, "/");
  const absolute = isAbsoluteQuery(normalized);
  const withoutTrailingSlash = normalized.replace(/\/+$/, "");
  const rootAnchored =
    absolute &&
    (/^\/[^/]+$/.test(withoutTrailingSlash) ||
      /^[a-z]:\/[^/]+$/i.test(withoutTrailingSlash) ||
      /^\/\/[^/]+\/[^/]+(?:\/[^/]+)?$/.test(withoutTrailingSlash));

  return {
    absolute,
    rootAnchored,
    rooted: normalized.startsWith("~") || normalized.startsWith("./") || absolute,
  };
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

function pathMatchesQuery(candidatePath: string, query: string, mode: PathQueryMode): boolean {
  const normalizedPath = candidatePath
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .toLowerCase();
  if (!mode.rooted && normalizedPath.includes(query)) {
    return true;
  }
  if (mode.absolute) {
    const absoluteQueryPath = (/^[a-z]:\//i.test(query) ? query : `/${query}`).replace(/\/+$/, "");
    if (
      normalizedPath === absoluteQueryPath ||
      normalizedPath.startsWith(`${absoluteQueryPath}/`)
    ) {
      return true;
    }
    // At a filesystem root, the anchored checks above are the whole contract:
    // `/tmp` may include `/tmp/project`, but not a fuzzy sibling like `/tmpfoo`.
    if (mode.rootAnchored) {
      return false;
    }
  }

  const querySegments = query.split("/");
  const basenameQuery = querySegments.pop() ?? "";
  const parentQuery = querySegments.join("/");
  const candidateSegments = normalizedPath.split("/");
  const basename = candidateSegments.pop() ?? "";
  const parentPath = candidateSegments.join("/");
  const relativeParentPath = parentPath.replace(/^\/+/, "");
  if (mode.absolute) {
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
