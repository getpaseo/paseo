import type { Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

export interface SearchHomeDirectoriesOptions {
  homeDir: string;
  query: string;
  limit?: number;
  maxDepth?: number;
  maxDirectoriesScanned?: number;
}

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_DIRECTORIES_SCANNED = 5000;
const DIRECTORY_LIST_CACHE_TTL_MS = 8_000;
const DIRECTORY_LIST_CACHE_MAX_ENTRIES = 4_000;

type QueryParts = {
  isPathQuery: boolean;
  parentPart: string;
  searchTerm: string;
};

type RankedDirectory = {
  absolutePath: string;
  matchTier: number;
  segmentIndex: number;
  matchOffset: number;
  depth: number;
};

type ChildDirectoryEntry = {
  name: string;
  absolutePath: string;
};

type DirectoryListCacheEntry = {
  expiresAt: number;
  entries: ChildDirectoryEntry[];
};

const directoryListCache = new Map<string, DirectoryListCacheEntry>();
const NO_SEGMENT_INDEX = Number.MAX_SAFE_INTEGER;
const NO_MATCH_OFFSET = Number.MAX_SAFE_INTEGER;

export async function searchHomeDirectories(
  options: SearchHomeDirectoriesOptions
): Promise<string[]> {
  const query = options.query.trim();
  if (!query) {
    return [];
  }

  const limit = normalizeLimit(options.limit);
  const homeRoot = await resolveDirectory(options.homeDir);
  if (!homeRoot) {
    return [];
  }

  const queryParts = normalizeQueryParts(query, homeRoot);
  if (!queryParts) {
    return [];
  }

  if (queryParts.isPathQuery) {
    return searchWithinParentDirectory({
      homeRoot,
      parentPart: queryParts.parentPart,
      searchTerm: queryParts.searchTerm,
      limit,
    });
  }

  return searchAcrossHomeTree({
    homeRoot,
    searchTerm: queryParts.searchTerm,
    limit,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxDirectoriesScanned:
      options.maxDirectoriesScanned ?? DEFAULT_MAX_DIRECTORIES_SCANNED,
  });
}

function normalizeLimit(limit: number | undefined): number {
  const candidate = limit ?? DEFAULT_LIMIT;
  if (!Number.isFinite(candidate)) {
    return DEFAULT_LIMIT;
  }
  const bounded = Math.trunc(candidate);
  return Math.max(1, Math.min(MAX_LIMIT, bounded));
}

async function searchWithinParentDirectory(input: {
  homeRoot: string;
  parentPart: string;
  searchTerm: string;
  limit: number;
}): Promise<string[]> {
  const parentPath = path.resolve(input.homeRoot, input.parentPart || ".");
  const parentRoot = await resolveDirectory(parentPath);
  if (!parentRoot || !isPathInsideRoot(input.homeRoot, parentRoot)) {
    return [];
  }

  const searchLower = input.searchTerm.toLowerCase();
  const ranked: RankedDirectory[] = [];
  const entries = await listChildDirectories({
    directory: parentRoot,
    homeRoot: input.homeRoot,
  });

  for (const entry of entries) {
    if (searchLower && !entry.name.toLowerCase().includes(searchLower)) {
      continue;
    }

    ranked.push(
      rankDirectory({
        absolutePath: entry.absolutePath,
        homeRoot: input.homeRoot,
        searchLower,
      })
    );
  }

  return dedupeAndSort(ranked).slice(0, input.limit);
}

async function searchAcrossHomeTree(input: {
  homeRoot: string;
  searchTerm: string;
  limit: number;
  maxDepth: number;
  maxDirectoriesScanned: number;
}): Promise<string[]> {
  const queue: Array<{ directory: string; depth: number }> = [
    { directory: input.homeRoot, depth: 0 },
  ];
  const visited = new Set<string>([input.homeRoot]);
  const ranked: RankedDirectory[] = [];
  let scanned = 0;
  const searchLower = input.searchTerm.toLowerCase();

  for (
    let queueIndex = 0;
    queueIndex < queue.length && scanned < input.maxDirectoriesScanned;
    queueIndex += 1
  ) {
    const current = queue[queueIndex];
    if (!current) continue;
    const entries = await listChildDirectories({
      directory: current.directory,
      homeRoot: input.homeRoot,
    });

    for (const entry of entries) {
      const resolvedCandidate = entry.absolutePath;
      if (visited.has(resolvedCandidate)) {
        continue;
      }
      visited.add(resolvedCandidate);
      scanned += 1;

      const relativePath = normalizeRelativePath(input.homeRoot, resolvedCandidate);
      if (
        relativePath.toLowerCase().includes(searchLower) ||
        entry.name.toLowerCase().includes(searchLower)
      ) {
        ranked.push(
          rankDirectory({
            absolutePath: resolvedCandidate,
            homeRoot: input.homeRoot,
            searchLower,
          })
        );
      }

      if (
        current.depth < input.maxDepth &&
        scanned < input.maxDirectoriesScanned
      ) {
        queue.push({ directory: resolvedCandidate, depth: current.depth + 1 });
      }
    }
  }

  return dedupeAndSort(ranked).slice(0, input.limit);
}

function dedupeAndSort(ranked: RankedDirectory[]): string[] {
  const byPath = new Map<string, RankedDirectory>();
  for (const entry of ranked) {
    const existing = byPath.get(entry.absolutePath);
    if (!existing || compareRankedDirectories(entry, existing) < 0) {
      byPath.set(entry.absolutePath, entry);
    }
  }

  return Array.from(byPath.values())
    .sort(compareRankedDirectories)
    .map((entry) => entry.absolutePath);
}

function compareRankedDirectories(
  left: RankedDirectory,
  right: RankedDirectory
): number {
  if (left.matchTier !== right.matchTier) {
    return left.matchTier - right.matchTier;
  }
  if (left.segmentIndex !== right.segmentIndex) {
    return left.segmentIndex - right.segmentIndex;
  }
  if (left.matchOffset !== right.matchOffset) {
    return left.matchOffset - right.matchOffset;
  }
  if (left.depth !== right.depth) {
    return left.depth - right.depth;
  }
  return left.absolutePath.localeCompare(right.absolutePath);
}

function rankDirectory(input: {
  absolutePath: string;
  homeRoot: string;
  searchLower: string;
}): RankedDirectory {
  const relative = normalizeRelativePath(input.homeRoot, input.absolutePath);
  const relativeLower = relative.toLowerCase();
  const depth = relative === "." ? 0 : relative.split("/").length;
  const searchLower = input.searchLower;
  if (!searchLower) {
    return {
      absolutePath: input.absolutePath,
      matchTier: 3,
      segmentIndex: NO_SEGMENT_INDEX,
      matchOffset: 0,
      depth,
    };
  }
  const segments = relativeLower === "." ? [] : relativeLower.split("/");
  const exactSegmentIndex = findSegmentMatchIndex(
    segments,
    (segment) => segment === searchLower
  );
  const prefixSegmentIndex = findSegmentMatchIndex(
    segments,
    (segment) => segment.startsWith(searchLower)
  );
  const partialSegmentIndex = findSegmentMatchIndex(
    segments,
    (segment) => segment.includes(searchLower)
  );
  const matchOffset = relativeLower.indexOf(searchLower);
  let matchTier = 4;
  let segmentIndex = NO_SEGMENT_INDEX;

  if (exactSegmentIndex >= 0) {
    matchTier = 0;
    segmentIndex = exactSegmentIndex;
  } else if (prefixSegmentIndex >= 0) {
    matchTier = 1;
    segmentIndex = prefixSegmentIndex;
  } else if (partialSegmentIndex >= 0) {
    matchTier = 2;
    segmentIndex = partialSegmentIndex;
  } else if (relativeLower.startsWith(searchLower)) {
    matchTier = 3;
  }

  return {
    absolutePath: input.absolutePath,
    matchTier,
    segmentIndex,
    matchOffset: matchOffset >= 0 ? matchOffset : NO_MATCH_OFFSET,
    depth,
  };
}

function findSegmentMatchIndex(
  segments: string[],
  predicate: (segment: string) => boolean
): number {
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment) {
      continue;
    }
    if (predicate(segment)) {
      return index;
    }
  }
  return -1;
}

function normalizeRelativePath(homeRoot: string, absolutePath: string): string {
  const relative = path.relative(homeRoot, absolutePath);
  if (!relative) {
    return ".";
  }
  return relative.split(path.sep).join("/");
}

function isPathInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function normalizeQueryParts(query: string, homeRoot: string): QueryParts | null {
  const typedQuery = query.trim().replace(/\\/g, "/");
  let normalized = typedQuery;
  if (!normalized) {
    return null;
  }

  if (normalized.startsWith("~")) {
    normalized = normalized.slice(1);
    if (normalized.startsWith("/")) {
      normalized = normalized.slice(1);
    }
  }

  if (path.isAbsolute(normalized)) {
    const absolute = path.resolve(normalized);
    if (!isPathInsideRoot(homeRoot, absolute)) {
      return null;
    }
    normalized = normalizeRelativePath(homeRoot, absolute);
  }

  normalized = normalized.replace(/^\.\/+/, "").replace(/\/{2,}/g, "/");
  if (!normalized) {
    // Treat "~" and "~/" as a request to browse the home root.
    if (typedQuery === "~" || typedQuery === "~/") {
      return {
        isPathQuery: true,
        parentPart: "",
        searchTerm: "",
      };
    }
    return null;
  }

  const isPathQuery = normalized.includes("/");
  const slashIndex = normalized.lastIndexOf("/");
  const parentPart = slashIndex >= 0 ? normalized.slice(0, slashIndex) : "";
  const searchTerm = slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;

  return {
    isPathQuery,
    parentPart,
    searchTerm,
  };
}

async function resolveDirectory(inputPath: string): Promise<string | null> {
  try {
    const resolved = await realpath(path.resolve(inputPath));
    const stats = await stat(resolved);
    if (!stats.isDirectory()) {
      return null;
    }
    return resolved;
  } catch {
    return null;
  }
}

async function listChildDirectories(input: {
  directory: string;
  homeRoot: string;
}): Promise<ChildDirectoryEntry[]> {
  const now = Date.now();
  const cached = directoryListCache.get(input.directory);
  if (cached && cached.expiresAt > now) {
    return cached.entries;
  }

  const dirents = await readdir(input.directory, { withFileTypes: true }).catch(
    () => [] as Dirent[]
  );
  const entries: ChildDirectoryEntry[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory() && !dirent.isSymbolicLink()) {
      continue;
    }
    const candidatePath = path.join(input.directory, dirent.name);
    const absolutePath = await resolveDirectoryCandidate({
      candidatePath,
      dirent,
      homeRoot: input.homeRoot,
    });
    if (!absolutePath) {
      continue;
    }
    entries.push({
      name: dirent.name,
      absolutePath,
    });
  }

  setDirectoryListCache(input.directory, {
    expiresAt: now + DIRECTORY_LIST_CACHE_TTL_MS,
    entries,
  });

  return entries;
}

async function resolveDirectoryCandidate(input: {
  candidatePath: string;
  dirent: Dirent;
  homeRoot: string;
}): Promise<string | null> {
  if (input.dirent.isDirectory()) {
    const resolved = path.resolve(input.candidatePath);
    return isPathInsideRoot(input.homeRoot, resolved) ? resolved : null;
  }

  const resolved = await resolveDirectory(input.candidatePath);
  if (!resolved || !isPathInsideRoot(input.homeRoot, resolved)) {
    return null;
  }
  return resolved;
}

function setDirectoryListCache(cacheKey: string, entry: DirectoryListCacheEntry): void {
  directoryListCache.set(cacheKey, entry);
  pruneDirectoryListCache();
}

function pruneDirectoryListCache(): void {
  if (directoryListCache.size <= DIRECTORY_LIST_CACHE_MAX_ENTRIES) {
    return;
  }

  const now = Date.now();
  for (const [cacheKey, entry] of directoryListCache) {
    if (entry.expiresAt <= now) {
      directoryListCache.delete(cacheKey);
    }
  }

  while (directoryListCache.size > DIRECTORY_LIST_CACHE_MAX_ENTRIES) {
    const oldestKey = directoryListCache.keys().next().value as string | undefined;
    if (!oldestKey) {
      return;
    }
    directoryListCache.delete(oldestKey);
  }
}
