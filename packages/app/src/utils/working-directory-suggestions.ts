import { scoreMatch } from "./score-match";

export interface BuildWorkingDirectorySuggestionsInput {
  recommendedPaths: string[];
  serverPaths: string[];
  query: string;
  rootPath?: string | null;
}

interface PathQueryContext {
  absoluteRootKind: AbsoluteRootKind | null;
  relativeRootAnchor: PathAnchor | null;
  rooted: boolean;
  rootedRelative: boolean;
}

interface PathQueryMode extends PathQueryContext {
  rootAnchored: boolean;
}

type AbsoluteRootKind = "posix" | "windows-drive" | "windows-unc";

interface PathAnchor {
  path: string;
  rootKind: AbsoluteRootKind;
}

export function buildWorkingDirectorySuggestions(
  input: BuildWorkingDirectorySuggestionsInput,
): string[] {
  const rawQuery = input.query.trim();
  const recommended = uniquePaths(input.recommendedPaths);
  if (!rawQuery) {
    return recommended;
  }

  const queryContext = getPathQueryContext(rawQuery, input.rootPath);
  const normalizedQuery = normalizeQuery(rawQuery, queryContext);
  const queryMode: PathQueryMode = {
    ...queryContext,
    rootAnchored: isRootAnchoredQuery(normalizedQuery, queryContext.absoluteRootKind),
  };
  const shouldFilterByQuery = normalizedQuery.length > 0;

  const recommendedMatches = shouldFilterByQuery
    ? recommended.filter((entry) => pathMatchesQuery(entry, normalizedQuery, queryMode, false))
    : recommended;
  const seen = new Set(recommendedMatches);
  const ordered = [...recommendedMatches];

  for (const entry of uniquePaths(input.serverPaths)) {
    if (shouldFilterByQuery && !pathMatchesQuery(entry, normalizedQuery, queryMode, true)) {
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

function getPathQueryContext(query: string, rootPath: string | null | undefined): PathQueryContext {
  const normalized = query.trim().replace(/\\/g, "/");
  const absoluteRootKind = getAbsoluteRootKind(normalized);
  const rootedRelative = normalized.startsWith("~") || normalized.startsWith("./");

  return {
    absoluteRootKind,
    relativeRootAnchor: rootedRelative ? getPathAnchor(rootPath) : null,
    rooted: rootedRelative || absoluteRootKind !== null,
    rootedRelative,
  };
}

function isRootAnchoredQuery(
  normalizedQuery: string,
  absoluteRootKind: AbsoluteRootKind | null,
): boolean {
  const withoutTrailingSlash = normalizedQuery.replace(/\/+$/, "");
  if (absoluteRootKind === "posix") {
    return /^[^/]+$/.test(withoutTrailingSlash);
  }
  if (absoluteRootKind === "windows-drive") {
    return /^[a-z]:\/[^/]+$/i.test(withoutTrailingSlash);
  }
  if (absoluteRootKind === "windows-unc") {
    return /^[^/]+\/[^/]+(?:\/[^/]+)?$/.test(withoutTrailingSlash);
  }
  return false;
}

function getPathAnchor(rootPath: string | null | undefined): PathAnchor | null {
  if (!rootPath) {
    return null;
  }
  const rootKind = getAbsoluteRootKind(rootPath);
  if (!rootKind) {
    return null;
  }
  return {
    path: normalizePath(rootPath),
    rootKind,
  };
}

function getAbsoluteRootKind(query: string): AbsoluteRootKind | null {
  const normalized = query.trim().replace(/\\/g, "/");
  if (normalized.startsWith("//")) {
    return "windows-unc";
  }
  if (/^[a-z]:\//i.test(normalized)) {
    return "windows-drive";
  }
  if (normalized.startsWith("/")) {
    return "posix";
  }
  return null;
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

function normalizeQuery(query: string, mode: PathQueryContext): string {
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
    .replace(/\/{2,}/g, "/");
  return (
    mode.rooted ? resolveQueryParentDotSegments(normalized, mode.absoluteRootKind) : normalized
  ).toLowerCase();
}

function resolveQueryParentDotSegments(
  query: string,
  absoluteRootKind: AbsoluteRootKind | null,
): string {
  const segments = query.split("/");
  const basename = segments.pop() ?? "";
  let protectedSegmentCount = 0;
  if (absoluteRootKind === "windows-drive") {
    protectedSegmentCount = 1;
  } else if (absoluteRootKind === "windows-unc") {
    protectedSegmentCount = 2;
  }
  const parentSegments: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      const canAscend =
        parentSegments.length > protectedSegmentCount && parentSegments.at(-1) !== "..";
      if (canAscend) {
        parentSegments.pop();
      } else if (absoluteRootKind === null) {
        parentSegments.push(segment);
      }
      continue;
    }
    parentSegments.push(segment);
  }
  return [...parentSegments, basename].join("/");
}

function normalizePath(candidatePath: string): string {
  return candidatePath
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function joinNormalizedPath(parentPath: string, childPath: string): string {
  const parent = parentPath.replace(/\/+$/, "");
  const child = childPath.replace(/^\/+/, "");
  return `${parent}/${child}`;
}

function parentMatchesQuery(input: {
  candidatePath: string;
  parentPath: string;
  parentQuery: string;
  mode: PathQueryMode;
  trustRootedRelative: boolean;
}): boolean {
  const relativeParentPath = input.parentPath.replace(/^\/+/, "");
  if (input.mode.absoluteRootKind !== null) {
    return relativeParentPath === input.parentQuery;
  }
  if (input.mode.rootedRelative) {
    const anchor = input.mode.relativeRootAnchor;
    if (!anchor) {
      return input.trustRootedRelative;
    }
    if (getAbsoluteRootKind(input.candidatePath) !== anchor.rootKind) {
      return false;
    }
    if (input.parentQuery) {
      return input.parentPath === joinNormalizedPath(anchor.path, input.parentQuery);
    }
    return input.parentPath === anchor.path || input.parentPath.startsWith(`${anchor.path}/`);
  }
  if (!input.parentQuery) {
    return true;
  }
  return (
    relativeParentPath === input.parentQuery || relativeParentPath.endsWith(`/${input.parentQuery}`)
  );
}

function pathMatchesQuery(
  candidatePath: string,
  query: string,
  mode: PathQueryMode,
  trustRootedRelative: boolean,
): boolean {
  if (
    mode.absoluteRootKind !== null &&
    getAbsoluteRootKind(candidatePath) !== mode.absoluteRootKind
  ) {
    return false;
  }
  const normalizedPath = normalizePath(candidatePath);
  if (!mode.rooted && normalizedPath.includes(query)) {
    return true;
  }
  if (mode.absoluteRootKind !== null) {
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
  if (
    !parentMatchesQuery({
      candidatePath,
      parentPath,
      parentQuery,
      mode,
      trustRootedRelative,
    })
  ) {
    return false;
  }
  if (!parentQuery && normalizedPath.includes(query)) {
    return true;
  }
  return scoreMatch(basenameQuery, basename) !== null;
}
