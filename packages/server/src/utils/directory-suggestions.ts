import type { Dirent, Stats } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { isPathInsideRoot } from "./path.js";

export type DirectorySuggestionKind = "file" | "directory";
export type DirectorySuggestionPathFormat = "absolute" | "relative";
export type DirectorySuggestionMatchMode = "fuzzy" | "suffix";
export type PathQueryPolicy = "rooted" | "slashes";
export type BlankQueryBehavior = "none" | "children";

export interface DirectorySuggestionEntry {
  path: string;
  kind: DirectorySuggestionKind;
}

export interface SearchDirectoryEntriesOptions {
  root: string;
  query: string;
  pathFormat: DirectorySuggestionPathFormat;
  includeFiles?: boolean;
  includeDirectories?: boolean;
  matchMode?: DirectorySuggestionMatchMode;
  pathQueryPolicy?: PathQueryPolicy;
  rootAliases?: string[];
  blankQueryBehavior?: BlankQueryBehavior;
  traversableHiddenDirectoryNames?: readonly string[];
  limit?: number;
  maxDepth?: number;
  maxEntriesScanned?: number;
  confidentResultScanThreshold?: number;
}

interface QueryPlan {
  isPathQuery: boolean;
  parentPart: string;
  searchTerm: string;
  normalizedQuery: string;
  browseExactPath?: boolean;
}

interface ChildEntry {
  name: string;
  resolvedPath: string;
  kind: DirectorySuggestionKind;
}

interface RawChildEntry {
  name: string;
  kind: DirectorySuggestionKind | "symlink";
}

interface TraversedEntry extends ChildEntry {
  visiblePath: string;
  depth: number;
}

interface RankedEntry extends DirectorySuggestionEntry {
  matchTier: number;
  segmentIndex: number;
  matchOffset: number;
  fuzzyScore: number;
  depth: number;
}

interface DirectoryListCacheEntry {
  expiresAt: number;
  modifiedAtMs: number;
  changedAtMs: number;
  entries: RawChildEntry[];
}

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_MAX_ENTRIES_SCANNED = 20_000;
const DIRECTORY_LIST_CACHE_TTL_MS = 8_000;
const DIRECTORY_LIST_CACHE_MAX_ENTRIES = 4_000;
// Windows does not reliably update directory mtime/ctime when children change,
// so metadata cannot safely validate a cross-request listing cache there.
const CAN_VALIDATE_DIRECTORY_CACHE_FROM_METADATA = process.platform !== "win32";
const MAX_CONFIDENT_FUZZY_SKIPS_PER_CHARACTER = 2;
const NO_SEGMENT_INDEX = Number.MAX_SAFE_INTEGER;
const NO_MATCH_OFFSET = Number.MAX_SAFE_INTEGER;
const NO_FUZZY_SCORE = Number.MAX_SAFE_INTEGER;
const NO_MATCH_TIER = 5;
export const WORKSPACE_SEARCH_HIDDEN_DIRECTORIES = [
  ".agents",
  ".claude",
  ".codex",
  ".github",
  ".opencode",
  ".paseo",
  ".vscode",
] as const;
const IGNORED_DIRECTORY_NAMES = new Set([
  "node_modules",
  "venv",
  "env",
  "virtualenv",
  "dist",
  "build",
  "target",
  "out",
  "coverage",
  "vendor",
  "__pycache__",
  ".git",
]);
const directoryListCache = new Map<string, DirectoryListCacheEntry>();

export async function searchDirectoryEntries(
  options: SearchDirectoryEntriesOptions,
): Promise<DirectorySuggestionEntry[]> {
  const root = await resolveDirectory(options.root);
  if (!root) return [];

  const input = buildSearchInput(options, root);
  if (!input) return [];

  const exact =
    input.plan.browseExactPath || (input.matchMode === "suffix" && input.plan.isPathQuery)
      ? await findExactEntry(input)
      : null;
  if (exact && input.limit === 1) return [exact];

  const browsesRoot = input.plan.isPathQuery && !input.plan.normalizedQuery;
  const ranked =
    input.plan.isPathQuery && (input.matchMode === "fuzzy" || browsesRoot)
      ? await searchChildren(input)
      : await searchTree(input);
  const results = sortAndFormat(ranked, input.root, input.pathFormat).slice(0, input.limit);
  return exact
    ? [exact, ...results.filter((entry) => !sameEntry(entry, exact))].slice(0, input.limit)
    : results;
}

function buildSearchInput(
  options: SearchDirectoryEntriesOptions,
  root: string,
): SearchInput | null {
  const includeDirectories = options.includeDirectories ?? true;
  const includeFiles = options.includeFiles ?? false;
  if (!includeDirectories && !includeFiles) return null;

  const plan = parseQuery({
    query: options.query,
    root,
    configuredRoot: path.resolve(options.root),
    policy: options.pathQueryPolicy ?? "slashes",
    aliases: options.rootAliases ?? [],
    blankBehavior: options.blankQueryBehavior ?? "none",
  });
  if (!plan) return null;

  return {
    root,
    plan,
    includeDirectories,
    includeFiles,
    matchMode: options.matchMode ?? "fuzzy",
    pathFormat: options.pathFormat,
    hiddenDirectoryNames: new Set(options.traversableHiddenDirectoryNames ?? []),
    limit: normalizeLimit(options.limit),
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxEntriesScanned: options.maxEntriesScanned ?? DEFAULT_MAX_ENTRIES_SCANNED,
    confidentResultScanThreshold: options.confidentResultScanThreshold,
  };
}

async function findExactEntry(input: SearchInput): Promise<DirectorySuggestionEntry | null> {
  if (!input.plan.normalizedQuery) return null;
  const visiblePath = path.resolve(input.root, input.plan.normalizedQuery);
  const resolvedPath = await realpath(visiblePath).catch(() => null);
  if (!resolvedPath || !isPathInsideRoot(input.root, resolvedPath)) return null;
  const info = await stat(resolvedPath).catch(() => null);
  const kind = getEntryKind(info);
  if (
    !kind ||
    (kind === "directory" && !input.includeDirectories) ||
    (kind === "file" && !input.includeFiles)
  )
    return null;
  return formatEntry({ path: visiblePath, kind }, input.root, input.pathFormat);
}

interface SearchInput {
  root: string;
  plan: QueryPlan;
  includeDirectories: boolean;
  includeFiles: boolean;
  matchMode: DirectorySuggestionMatchMode;
  pathFormat: DirectorySuggestionPathFormat;
  hiddenDirectoryNames: Set<string>;
  limit: number;
  maxDepth: number;
  maxEntriesScanned: number;
  confidentResultScanThreshold: number | undefined;
}

async function searchChildren(input: SearchInput): Promise<RankedEntry[]> {
  const visibleParent = path.resolve(input.root, input.plan.parentPart || ".");
  const parent = await realpath(visibleParent).catch(() => null);
  if (!parent || !isPathInsideRoot(input.root, parent)) return [];
  const entries = await readChildren(parent);
  return entries.flatMap((entry) => {
    if (!isPathInsideRoot(input.root, entry.resolvedPath) || !shouldDiscover(entry, input))
      return [];
    const candidate: TraversedEntry = {
      ...entry,
      visiblePath: path.join(visibleParent, entry.name),
      depth: 1,
    };
    return shouldSuggest(candidate, input) ? [rank(candidate, input)] : [];
  });
}

async function searchTree(input: SearchInput): Promise<RankedEntry[]> {
  if (!(input.maxEntriesScanned > 0)) return [];
  const roots = (await readChildren(input.root)).filter((entry) =>
    isPathInsideRoot(input.root, entry.resolvedPath),
  );
  const visited = new Set<string>([input.root]);
  const branches = roots.flatMap((entry) =>
    shouldDiscover(entry, input)
      ? [
          walkBranch(
            { ...entry, visiblePath: path.join(input.root, entry.name), depth: 1 },
            input,
            visited,
          ),
        ]
      : [],
  );
  const ranked: RankedEntry[] = [];
  let scanned = 0;
  const threshold = input.confidentResultScanThreshold;
  for await (const entry of roundRobin(branches)) {
    scanned += 1;
    if (shouldSuggest(entry, input)) ranked.push(rank(entry, input));
    if (
      scanned >= input.maxEntriesScanned ||
      (threshold && scanned >= threshold && hasConfidentResult(ranked, input.plan.searchTerm))
    )
      break;
  }
  return ranked;
}

async function* walkBranch(
  entry: TraversedEntry,
  input: SearchInput,
  visited: Set<string>,
): AsyncGenerator<TraversedEntry> {
  yield entry;
  if (
    entry.kind !== "directory" ||
    visited.has(entry.resolvedPath) ||
    entry.depth >= input.maxDepth
  )
    return;
  visited.add(entry.resolvedPath);
  const children = (await readChildren(entry.resolvedPath)).filter((child) =>
    isPathInsideRoot(input.root, child.resolvedPath),
  );
  const branches = children.flatMap((child) =>
    shouldDiscover(child, input)
      ? [
          walkBranch(
            {
              ...child,
              visiblePath: path.join(entry.visiblePath, child.name),
              depth: entry.depth + 1,
            },
            input,
            visited,
          ),
        ]
      : [],
  );
  yield* roundRobin(branches);
}

async function* roundRobin<T>(branches: Array<AsyncGenerator<T>>): AsyncGenerator<T> {
  let active = branches;
  while (active.length) {
    const nextRound: Array<AsyncGenerator<T>> = [];
    for (const branch of active) {
      const next = await branch.next();
      if (!next.done) {
        nextRound.push(branch);
        yield next.value;
      }
    }
    active = nextRound;
  }
}

function shouldDiscover(entry: ChildEntry, input: SearchInput): boolean {
  if (entry.kind === "file") {
    return input.includeFiles && !entry.name.startsWith(".");
  }
  if (IGNORED_DIRECTORY_NAMES.has(entry.name)) return false;
  if (!entry.name.startsWith(".")) return true;
  return input.hiddenDirectoryNames.has(entry.name);
}

function shouldSuggest(entry: TraversedEntry, input: SearchInput): boolean {
  if (entry.name.startsWith(".")) return false;
  if (entry.kind === "directory" && !input.includeDirectories) return false;
  if (entry.kind === "file" && !input.includeFiles) return false;
  if (!input.plan.normalizedQuery) return true;
  if (input.matchMode === "suffix")
    return suffixMatches(entry.visiblePath, input.root, input.plan.normalizedQuery);
  return !input.plan.searchTerm || rank(entry, input).matchTier !== NO_MATCH_TIER;
}

function rank(entry: TraversedEntry, input: SearchInput): RankedEntry {
  const relativePath = normalizeRelativePath(input.root, entry.visiblePath);
  const lowerPath = relativePath.toLowerCase();
  const query = input.plan.searchTerm.toLowerCase();
  const segments = lowerPath === "." ? [] : lowerPath.split("/");
  const exact = findSegmentMatchIndex(segments, (segment) => segment === query);
  const prefix = findSegmentMatchIndex(segments, (segment) => segment.startsWith(query));
  const substring = findSegmentMatchIndex(segments, (segment) => segment.includes(query));
  const offset = lowerPath.indexOf(query);
  const fuzzyScore = scoreFuzzySubsequence(query, segments.at(-1) ?? "");
  let matchTier = NO_MATCH_TIER;
  let segmentIndex = NO_SEGMENT_INDEX;
  if (!query) matchTier = 3;
  else if (exact >= 0) {
    matchTier = 0;
    segmentIndex = exact;
  } else if (prefix >= 0) {
    matchTier = 1;
    segmentIndex = prefix;
  } else if (substring >= 0) {
    matchTier = 2;
    segmentIndex = substring;
  } else if (input.pathFormat === "relative" ? lowerPath.startsWith(query) : offset >= 0)
    matchTier = 3;
  else if (fuzzyScore !== null) matchTier = 4;
  return {
    path: entry.visiblePath,
    kind: entry.kind,
    matchTier,
    segmentIndex,
    matchOffset: offset >= 0 ? offset : NO_MATCH_OFFSET,
    fuzzyScore: fuzzyScore ?? NO_FUZZY_SCORE,
    depth: relativePath === "." ? 0 : segments.length,
  };
}

function sortAndFormat(
  entries: RankedEntry[],
  root: string,
  format: DirectorySuggestionPathFormat,
): DirectorySuggestionEntry[] {
  const unique = new Map<string, RankedEntry>();
  for (const entry of entries) {
    const key = `${entry.kind}:${entry.path}`;
    const existing = unique.get(key);
    if (!existing || compareRank(entry, existing) < 0) unique.set(key, entry);
  }
  return [...unique.values()].sort(compareRank).map((entry) => formatEntry(entry, root, format));
}

function formatEntry(
  entry: DirectorySuggestionEntry,
  root: string,
  format: DirectorySuggestionPathFormat,
): DirectorySuggestionEntry {
  return {
    path: format === "absolute" ? entry.path : normalizeRelativePath(root, entry.path),
    kind: entry.kind,
  };
}

function compareRank(left: RankedEntry, right: RankedEntry): number {
  return (
    left.matchTier - right.matchTier ||
    left.segmentIndex - right.segmentIndex ||
    left.matchOffset - right.matchOffset ||
    left.fuzzyScore - right.fuzzyScore ||
    left.depth - right.depth ||
    compareKinds(left.kind, right.kind) ||
    left.path.localeCompare(right.path)
  );
}

function compareKinds(left: DirectorySuggestionKind, right: DirectorySuggestionKind): number {
  if (left === right) return 0;
  return left === "directory" ? -1 : 1;
}

function hasConfidentResult(entries: RankedEntry[], query: string): boolean {
  const maxFuzzyScore = query.length * MAX_CONFIDENT_FUZZY_SKIPS_PER_CHARACTER;
  return entries.some(
    (entry) => entry.matchTier < 4 || (entry.matchTier === 4 && entry.fuzzyScore <= maxFuzzyScore),
  );
}

function suffixMatches(visiblePath: string, root: string, query: string): boolean {
  const querySegments = query.toLowerCase().split("/").filter(Boolean);
  if (querySegments.length === 0) return false;
  const pathSegments = normalizeRelativePath(root, visiblePath)
    .toLowerCase()
    .split("/")
    .filter(Boolean);
  const offset = pathSegments.length - querySegments.length;
  return (
    offset >= 0 && querySegments.every((segment, index) => pathSegments[offset + index] === segment)
  );
}

function parseQuery(input: {
  query: string;
  root: string;
  configuredRoot: string;
  policy: PathQueryPolicy;
  aliases: string[];
  blankBehavior: BlankQueryBehavior;
}): QueryPlan | null {
  const normalizedInput = normalizeQueryInput(input);
  if (!normalizedInput) return null;
  const { typed, rooted } = normalizedInput;
  const normalized = normalizedInput.normalized;

  if (!normalized) {
    const explicitlyBrowseRoot = rooted || typed === ".";
    if (!explicitlyBrowseRoot && input.blankBehavior !== "children") return null;
    return { isPathQuery: true, parentPart: "", searchTerm: "", normalizedQuery: "" };
  }
  if (normalizedInput.isAbsolute && isFilesystemRoot(input.root) && !normalized.includes("/")) {
    return {
      isPathQuery: true,
      parentPart: normalized,
      searchTerm: "",
      normalizedQuery: normalized,
      browseExactPath: true,
    };
  }
  const isPathQuery = rooted || (input.policy === "slashes" && normalized.includes("/"));
  const slash = normalized.lastIndexOf("/");
  return {
    isPathQuery,
    parentPart: isPathQuery && slash >= 0 ? normalized.slice(0, slash) : "",
    searchTerm: isPathQuery && slash >= 0 ? normalized.slice(slash + 1) : normalized,
    normalizedQuery: normalized,
  };
}

function normalizeQueryInput(input: {
  query: string;
  root: string;
  configuredRoot: string;
  aliases: string[];
}): { typed: string; normalized: string; rooted: boolean; isAbsolute: boolean } | null {
  const typed = input.query.trim().replace(/\\/g, "/");
  let normalized = typed;
  let rooted = false;
  let isAbsolute = false;
  for (const alias of input.aliases) {
    if (normalized === alias || normalized.startsWith(`${alias}/`)) {
      rooted = true;
      normalized = normalized.slice(alias.length).replace(/^\/+/, "");
      break;
    }
  }
  if (path.isAbsolute(normalized)) {
    isAbsolute = true;
    const browseAbsoluteDirectory = normalized.endsWith("/");
    const absolutePath = path.resolve(normalized);
    let queryRoot: string | null = null;
    if (isPathInsideRoot(input.root, absolutePath)) {
      queryRoot = input.root;
    } else if (isPathInsideRoot(input.configuredRoot, absolutePath)) {
      queryRoot = input.configuredRoot;
    }
    if (!queryRoot) return null;
    rooted = true;
    normalized = normalizeRelativePath(queryRoot, absolutePath);
    if (browseAbsoluteDirectory && normalized !== ".") {
      normalized = `${normalized}/`;
    }
  }
  if (normalized.startsWith("./")) rooted = true;
  normalized = normalized.replace(/^\.\/+/, "").replace(/\/{2,}/g, "/");
  if (normalized === "." && (rooted || typed === ".")) {
    normalized = "";
  }
  return { typed, normalized, rooted, isAbsolute };
}

function isFilesystemRoot(inputPath: string): boolean {
  return path.relative(path.parse(inputPath).root, inputPath) === "";
}

async function resolveDirectory(inputPath: string): Promise<string | null> {
  const resolved = await realpath(path.resolve(inputPath)).catch(() => null);
  if (!resolved) return null;
  const info = await stat(resolved).catch(() => null);
  return info?.isDirectory() ? resolved : null;
}

async function readChildren(directory: string): Promise<ChildEntry[]> {
  const directoryInfo = await stat(directory).catch(() => null);
  if (!directoryInfo?.isDirectory()) return [];

  const cached = CAN_VALIDATE_DIRECTORY_CACHE_FROM_METADATA
    ? directoryListCache.get(directory)
    : undefined;
  let rawEntries: RawChildEntry[];
  if (
    cached &&
    cached.expiresAt > Date.now() &&
    cached.modifiedAtMs === directoryInfo.mtimeMs &&
    cached.changedAtMs === directoryInfo.ctimeMs
  ) {
    rawEntries = cached.entries;
  } else {
    const dirents = await readdir(directory, { withFileTypes: true }).catch(() => [] as Dirent[]);
    rawEntries = dirents
      .map(toRawChildEntry)
      .filter((entry): entry is RawChildEntry => entry !== null)
      .sort((left, right) => left.name.localeCompare(right.name));
    if (CAN_VALIDATE_DIRECTORY_CACHE_FROM_METADATA) {
      directoryListCache.set(directory, {
        expiresAt: Date.now() + DIRECTORY_LIST_CACHE_TTL_MS,
        modifiedAtMs: directoryInfo.mtimeMs,
        changedAtMs: directoryInfo.ctimeMs,
        entries: rawEntries,
      });
      pruneCache();
    }
  }

  return (await Promise.all(rawEntries.map((entry) => resolveChild(directory, entry))))
    .filter((entry): entry is ChildEntry => entry !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function toRawChildEntry(dirent: Dirent): RawChildEntry | null {
  if (dirent.isDirectory()) return { name: dirent.name, kind: "directory" };
  if (dirent.isFile()) return { name: dirent.name, kind: "file" };
  if (dirent.isSymbolicLink()) return { name: dirent.name, kind: "symlink" };
  return null;
}

async function resolveChild(directory: string, entry: RawChildEntry): Promise<ChildEntry | null> {
  const visiblePath = path.join(directory, entry.name);
  if (entry.kind !== "symlink") {
    return { name: entry.name, resolvedPath: visiblePath, kind: entry.kind };
  }

  const resolvedPath = await realpath(visiblePath).catch(() => null);
  if (!resolvedPath) return null;
  const info = await stat(resolvedPath).catch(() => null);
  const kind = getEntryKind(info);
  return kind ? { name: entry.name, resolvedPath, kind } : null;
}

function getEntryKind(info: Stats | null): DirectorySuggestionKind | null {
  if (info?.isDirectory()) return "directory";
  if (info?.isFile()) return "file";
  return null;
}

function pruneCache(): void {
  if (directoryListCache.size <= DIRECTORY_LIST_CACHE_MAX_ENTRIES) return;
  for (const [key, entry] of directoryListCache)
    if (entry.expiresAt <= Date.now()) directoryListCache.delete(key);
  while (directoryListCache.size > DIRECTORY_LIST_CACHE_MAX_ENTRIES) {
    const key = directoryListCache.keys().next().value;
    if (!key) return;
    directoryListCache.delete(key);
  }
}

function normalizeLimit(limit: number | undefined): number {
  const candidate =
    typeof limit === "number" && Number.isFinite(limit) ? Math.trunc(limit) : DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, candidate));
}

function normalizeRelativePath(root: string, absolutePath: string): string {
  const relative = path.relative(root, absolutePath);
  return relative ? relative.split(path.sep).join("/") : ".";
}

function scoreFuzzySubsequence(query: string, candidate: string): number | null {
  let queryIndex = 0;
  let first = -1;
  let previous = -1;
  let gaps = 0;
  for (let index = 0; index < candidate.length && queryIndex < query.length; index += 1) {
    if (candidate[index] !== query[queryIndex]) continue;
    if (first < 0) first = index;
    if (previous >= 0) gaps += index - previous - 1;
    previous = index;
    queryIndex += 1;
  }
  return queryIndex === query.length && first >= 0 ? first + gaps : null;
}

function findSegmentMatchIndex(
  segments: string[],
  predicate: (segment: string) => boolean,
): number {
  return segments.findIndex((segment) => predicate(segment));
}

function sameEntry(left: DirectorySuggestionEntry, right: DirectorySuggestionEntry): boolean {
  return left.path === right.path && left.kind === right.kind;
}
