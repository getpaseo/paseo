import type { Dirent, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import pLimit from "p-limit";
import { scorePathMatch, type MatchScore } from "@getpaseo/protocol/search/text-match";
import { isPathInsideRoot } from "./path.js";
import {
  characterMask,
  compactQuery,
  containsCompact,
  isAscii,
  keepBest,
  mayMatch,
  type BuildIndex,
  type IndexedEntry,
  type PathIndexes,
} from "./path-index.js";
import { runGitCommand } from "./run-git-command.js";

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
  respectGitIgnore?: boolean;
  // Absolute paths that discovery never walks into. A path the caller types explicitly still
  // resolves, and browsing inside one lists a single level at a time.
  excludedDiscoveryPaths?: readonly string[];
  pathIndexes?: PathIndexes;
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
  viaSymlink: boolean;
}

interface RawChildEntry {
  name: string;
  kind: DirectorySuggestionKind | "symlink";
}

interface WalkStart {
  visiblePath: string;
  resolvedPath: string;
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

interface RankFields {
  matchTier: number;
  segmentIndex: number;
  matchOffset: number;
  fuzzyScore: number;
}

interface DirectoryListCacheEntry {
  expiresAt: number;
  modifiedAtMs: number;
  changedAtMs: number;
  entries: RawChildEntry[];
}

interface GitIgnoredPathsCacheEntry {
  expiresAt: number;
  paths: Promise<Set<string>>;
}

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_MAX_ENTRIES_SCANNED = 20_000;
const DIRECTORY_LIST_CACHE_TTL_MS = 8_000;
const DIRECTORY_LIST_CACHE_MAX_ENTRIES = 4_000;
const GIT_IGNORED_PATHS_CACHE_TTL_MS = 8_000;
const GIT_IGNORED_PATHS_CACHE_MAX_ENTRIES = 256;
// Windows does not reliably update directory mtime/ctime when children change,
// so metadata cannot safely validate a cross-request listing cache there.
const CAN_VALIDATE_DIRECTORY_CACHE_FROM_METADATA = process.platform !== "win32";
const MAX_CONFIDENT_FUZZY_SKIPS_PER_CHARACTER = 2;
const NO_SEGMENT_INDEX = Number.MAX_SAFE_INTEGER;
const NO_MATCH_OFFSET = Number.MAX_SAFE_INTEGER;
const NO_FUZZY_SCORE = Number.MAX_SAFE_INTEGER;
const NO_MATCH_TIER = 5;
const FALLBACK_TIER = 4;
const INDEX_BUILD_YIELD_MS = 5;
const URGENT_INDEX_BUILD_CONCURRENCY = 2;
const INDEX_BUILD_MAX_YIELD_MS = 10_000;
const INDEX_BUILD_BATCH = 64;

// Each pending fs call holds one of libuv's shared threadpool threads (4 by default), and a read on
// a hung mount or a protected folder never returns. Searches pile up while the user types, so they
// share two threads and leave the rest of the pool to the daemon. Searches over one tree walk it
// in the same order and stop at the same stuck folder, so they share its pending call and hold one
// thread between them instead of both.
const filesystemCalls = pLimit(2);
const pendingFilesystemCalls = new Map<string, Promise<unknown>>();
let activeWalks = 0;

function sharedFilesystemCall<T>(key: string, call: () => Promise<T>): Promise<T> {
  const pending = pendingFilesystemCalls.get(key);
  if (pending) return pending as Promise<T>;
  const started = filesystemCalls(call).finally(() => pendingFilesystemCalls.delete(key));
  pendingFilesystemCalls.set(key, started);
  return started;
}

function readdir(directory: string): Promise<Dirent[]> {
  return sharedFilesystemCall(`readdir:${directory}`, () =>
    fs.readdir(directory, { withFileTypes: true }),
  );
}

function realpath(target: string): Promise<string> {
  return sharedFilesystemCall(`realpath:${target}`, () => fs.realpath(target));
}

function stat(target: string): Promise<Stats> {
  return sharedFilesystemCall(`stat:${target}`, () => fs.stat(target));
}

export const WORKSPACE_SEARCH_HIDDEN_DIRECTORIES = [
  ".agents",
  ".claude",
  ".codex",
  ".cursor",
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
const gitIgnoredPathsCache = new Map<string, GitIgnoredPathsCacheEntry>();

// Discovery and retrieval filter differently, on purpose. Discovery — anything that ranks or
// browses candidates the caller has not named — drops gitignored and hidden entries, so pickers
// do not offer build output. Retrieval of a path the caller named exactly applies no ignore or
// hidden filtering; the only question is whether the path stays inside the root. Clicking a file
// reference an agent wrote must open it whether or not Git tracks it.
export async function searchDirectoryEntries(
  options: SearchDirectoryEntriesOptions,
): Promise<DirectorySuggestionEntry[]> {
  const root = await resolveDirectory(options.root);
  if (!root) return [];

  const gitIgnoredPaths = options.respectGitIgnore
    ? await loadGitIgnoredPaths(root)
    : new Set<string>();
  const excludedDiscoveryPaths = await resolveExistingPaths(options.excludedDiscoveryPaths ?? []);
  const input = buildSearchInput(options, root, gitIgnoredPaths, excludedDiscoveryPaths);
  if (!input) return [];

  const exact =
    input.plan.browseExactPath ||
    (input.plan.isPathQuery && (input.matchMode === "suffix" || resolvesTypedPath(input)))
      ? await findExactEntry(input)
      : null;
  if (exact && input.limit === 1) return [exact];

  const ranked = await searchCandidates(input);
  const results = sortAndFormat(ranked, input.root, input.pathFormat).slice(0, input.limit);
  return exact
    ? [exact, ...results.filter((entry) => !sameEntry(entry, exact))].slice(0, input.limit)
    : results;
}

async function searchCandidates(input: SearchInput): Promise<RankedEntry[]> {
  const browsesRoot = input.plan.isPathQuery && !input.plan.normalizedQuery;
  const browsesAbsoluteParent = input.plan.browseExactPath === true;
  if (browsesRoot || browsesAbsoluteParent) return searchChildren(input);
  if (!resolvesTypedPath(input) || !input.plan.parentPart) return searchTree(input);

  // A typed parent such as `~/Developer/pas` anchors the walk under `~/Developer`. A parent that
  // does not exist falls back to matching the typed path against the whole tree.
  const typedParent = await resolveTypedParent(input);
  if (!typedParent) return searchTree(input);
  if (isInsideExcludedPath(typedParent.resolvedPath, input)) return searchChildren(input);
  return searchTree(input, typedParent);
}

// Only a rooted query under the rooted policy names a location. Under the slashes policy a query
// with a slash is still a fragment that may match anywhere in the tree.
function resolvesTypedPath(input: SearchInput): boolean {
  return input.pathQueryPolicy === "rooted" && input.plan.isPathQuery;
}

async function resolveTypedParent(input: SearchInput): Promise<WalkStart | null> {
  const visiblePath = path.resolve(input.root, input.plan.parentPart);
  const resolvedPath = await realpath(visiblePath).catch(() => null);
  if (!resolvedPath || !isPathInsideRoot(input.root, resolvedPath)) return null;
  const info = await stat(resolvedPath).catch(() => null);
  return info?.isDirectory() ? { visiblePath, resolvedPath } : null;
}

async function resolveExistingPaths(paths: readonly string[]): Promise<Set<string>> {
  const resolved = await Promise.all(
    paths.map((candidate) => realpath(path.resolve(candidate)).catch(() => null)),
  );
  return new Set(resolved.filter((candidate): candidate is string => candidate !== null));
}

function buildSearchInput(
  options: SearchDirectoryEntriesOptions,
  root: string,
  gitIgnoredPaths: Set<string>,
  excludedDiscoveryPaths: Set<string>,
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
    pathQueryPolicy: options.pathQueryPolicy ?? "slashes",
    pathFormat: options.pathFormat,
    hiddenDirectoryNames: new Set(options.traversableHiddenDirectoryNames ?? []),
    limit: normalizeLimit(options.limit),
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxEntriesScanned: options.maxEntriesScanned ?? DEFAULT_MAX_ENTRIES_SCANNED,
    confidentResultScanThreshold: options.confidentResultScanThreshold,
    gitIgnoredPaths,
    excludedDiscoveryPaths,
    respectGitIgnore: options.respectGitIgnore ?? false,
    pathIndexes: options.pathIndexes,
  };
}

async function findExactEntry(input: SearchInput): Promise<DirectorySuggestionEntry | null> {
  if (!input.plan.normalizedQuery) return null;
  const visiblePath = path.resolve(input.root, input.plan.normalizedQuery);
  const resolvedPath = await realpath(visiblePath).catch(() => null);
  if (!resolvedPath || !isPathInsideRoot(input.root, resolvedPath)) return null;
  // No ignore filtering here: the caller named this exact path, so containment above is the
  // only question left to answer. Filtering belongs to discovery, not retrieval.
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
  pathQueryPolicy: PathQueryPolicy;
  pathFormat: DirectorySuggestionPathFormat;
  hiddenDirectoryNames: Set<string>;
  limit: number;
  maxDepth: number;
  maxEntriesScanned: number;
  confidentResultScanThreshold: number | undefined;
  gitIgnoredPaths: Set<string>;
  excludedDiscoveryPaths: Set<string>;
  respectGitIgnore: boolean;
  pathIndexes: PathIndexes | undefined;
}

async function searchChildren(input: SearchInput): Promise<RankedEntry[]> {
  const visibleParent = path.resolve(input.root, input.plan.parentPart || ".");
  const parent = await realpath(visibleParent).catch(() => null);
  if (!parent || !isPathInsideRoot(input.root, parent)) return [];
  if (isGitIgnoredPath(parent, input)) return [];
  // Browsing inside an excluded path is explicit: the caller typed it, so list what is there.
  const discoveryInput = isInsideExcludedPath(parent, input)
    ? { ...input, excludedDiscoveryPaths: new Set<string>() }
    : input;
  const entries = await readChildren(parent);
  return entries.flatMap((entry) => {
    if (!isPathInsideRoot(input.root, entry.resolvedPath) || !shouldDiscover(entry, discoveryInput))
      return [];
    const candidate: TraversedEntry = {
      ...entry,
      visiblePath: path.join(visibleParent, entry.name),
      depth: 1,
    };
    return shouldSuggest(candidate, input) ? [rank(candidate, input)] : [];
  });
}

async function searchTree(
  input: SearchInput,
  start: WalkStart = { visiblePath: input.root, resolvedPath: input.root },
): Promise<RankedEntry[]> {
  if (!(input.maxEntriesScanned > 0)) return [];
  const pathIndexes = input.pathIndexes;
  if (!pathIndexes || start.resolvedPath !== input.root || start.visiblePath !== input.root) {
    return walkTree(input, start);
  }
  const key = indexKey(input);
  const signature = ignoreSignature(input.gitIgnoredPaths);
  const build: BuildIndex = (isUrgent) => buildIndex(input, pathIndexes.maxEntries, isUrgent);
  const entries = await pathIndexes.get(key, signature, build);
  if (entries && pathIndexes.watched) return searchIndex(entries, input);
  const walked = await walkTree(input, start);
  pathIndexes.prepare(key, input.root, signature, build);
  return entries ? [...walked, ...searchIndex(entries, input)] : walked;
}

async function walkTree(input: SearchInput, start: WalkStart): Promise<RankedEntry[]> {
  activeWalks += 1;
  try {
    return await walkTreeBranches(input, start);
  } finally {
    activeWalks -= 1;
  }
}

async function walkTreeBranches(input: SearchInput, start: WalkStart): Promise<RankedEntry[]> {
  const roots = (await readChildren(start.resolvedPath)).filter((entry) =>
    staysInsideRoot(entry, input.root),
  );
  const visited = new Set<string>([start.resolvedPath]);
  const branches = roots.flatMap((entry) =>
    shouldDiscover(entry, input)
      ? [
          walkBranch(
            { ...entry, visiblePath: path.join(start.visiblePath, entry.name), depth: 1 },
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
      (threshold &&
        scanned >= threshold &&
        hasConfidentResult(ranked, input.plan.normalizedQuery || input.plan.searchTerm))
    )
      break;
  }
  return ranked;
}

function indexKey(input: SearchInput): string {
  return JSON.stringify([
    input.root,
    input.includeFiles,
    input.maxDepth,
    input.respectGitIgnore,
    [...input.hiddenDirectoryNames].sort(),
    [...input.excludedDiscoveryPaths].sort(),
  ]);
}

const ignoreSignatures = new WeakMap<Set<string>, string>();

function ignoreSignature(gitIgnoredPaths: Set<string>): string {
  let signature = ignoreSignatures.get(gitIgnoredPaths);
  if (signature === undefined) {
    signature = [...gitIgnoredPaths].sort().join("\0");
    ignoreSignatures.set(gitIgnoredPaths, signature);
  }
  return signature;
}

interface IndexedDirectory {
  resolvedPath: string;
  relativePath: string;
  depth: number;
}

interface IndexBuild {
  entries: IndexedEntry[];
  visited: Set<string>;
  next: IndexedDirectory[];
  links: IndexedDirectory[];
}

async function buildIndex(
  input: SearchInput,
  maxEntries: number,
  isUrgent: () => boolean,
): Promise<IndexedEntry[] | null> {
  const yieldUntil = Date.now() + INDEX_BUILD_MAX_YIELD_MS;
  const into: IndexBuild = { entries: [], visited: new Set([input.root]), next: [], links: [] };
  let level: IndexedDirectory[] = [{ resolvedPath: input.root, relativePath: "", depth: 0 }];
  while (level.length > 0) {
    for (let start = 0; start < level.length; start += INDEX_BUILD_BATCH) {
      const batch = level.slice(start, start + INDEX_BUILD_BATCH);
      const listings = await listBatch(batch, isUrgent, yieldUntil);
      for (const [index, children] of listings.entries()) {
        if (!indexChildren(batch[index], children, input, into, maxEntries)) return null;
      }
    }
    level = into.next.length > 0 ? into.next : unvisitedLinks(into);
    into.next = [];
  }
  return into.entries;
}

function unvisitedLinks(into: IndexBuild): IndexedDirectory[] {
  const links = into.links.filter((link) => !into.visited.has(link.resolvedPath));
  for (const link of links) into.visited.add(link.resolvedPath);
  into.links = [];
  return links;
}

async function listBatch(
  batch: IndexedDirectory[],
  isUrgent: () => boolean,
  yieldUntil: number,
): Promise<ChildEntry[][]> {
  const listings: ChildEntry[][] = [];
  let next = 0;
  const worker = async () => {
    while (next < batch.length) {
      const index = next;
      next += 1;
      listings[index] = await listWhenSearchesIdle(batch[index].resolvedPath, isUrgent, yieldUntil);
    }
  };
  const workers = isUrgent() ? URGENT_INDEX_BUILD_CONCURRENCY : 1;
  await Promise.all(Array.from({ length: workers }, worker));
  return listings;
}

function searchesAreWaiting(): boolean {
  return activeWalks > 0 || filesystemCalls.pendingCount > 0;
}

async function listWhenSearchesIdle(
  directory: string,
  isUrgent: () => boolean,
  yieldUntil: number,
): Promise<ChildEntry[]> {
  while (!isUrgent() && searchesAreWaiting() && Date.now() < yieldUntil) {
    await new Promise((resolve) => setTimeout(resolve, INDEX_BUILD_YIELD_MS));
  }
  return listForIndex(directory);
}

async function listForIndex(directory: string): Promise<ChildEntry[]> {
  const dirents = await readdir(directory).catch(() => [] as Dirent[]);
  const prefix = directory.endsWith(path.sep) ? directory : directory + path.sep;
  const children: ChildEntry[] = [];
  const links: Array<Promise<ChildEntry | null>> = [];
  for (const dirent of dirents) {
    const entry = toRawChildEntry(dirent);
    if (!entry) continue;
    if (entry.kind === "symlink") {
      links.push(resolveChild(directory, entry));
      continue;
    }
    children.push({
      name: entry.name,
      resolvedPath: prefix + entry.name,
      kind: entry.kind,
      viaSymlink: false,
    });
  }
  for (const link of await Promise.all(links)) {
    if (link) children.push(link);
  }
  return children;
}

function indexChildren(
  parent: IndexedDirectory,
  children: ChildEntry[],
  input: SearchInput,
  into: IndexBuild,
  maxEntries: number,
): boolean {
  for (const child of children) {
    if (!staysInsideRoot(child, input.root) || !shouldDiscover(child, input)) continue;
    const relativePath = parent.relativePath ? `${parent.relativePath}/${child.name}` : child.name;
    if (!child.name.startsWith(".")) {
      const lowerPath = relativePath.toLowerCase();
      into.entries.push({
        kind: child.kind,
        relativePath,
        lowerPath,
        mask: characterMask(lowerPath),
        ascii: isAscii(relativePath),
      });
      if (into.entries.length > maxEntries) return false;
    }
    const depth = parent.depth + 1;
    if (
      child.kind !== "directory" ||
      into.visited.has(child.resolvedPath) ||
      depth >= input.maxDepth
    )
      continue;
    const directory = { resolvedPath: child.resolvedPath, relativePath, depth };
    if (child.viaSymlink) {
      into.links.push(directory);
      continue;
    }
    into.visited.add(child.resolvedPath);
    into.next.push(directory);
  }
  return true;
}

interface IndexQuery {
  suffix: boolean;
  rankQuery: string;
  query: string;
  compact: string;
  mask: number;
  rootPrefix: string;
}

function searchIndex(entries: IndexedEntry[], input: SearchInput): RankedEntry[] {
  const suffix = input.matchMode === "suffix";
  const rankQuery = getRankQuery(input);
  const query = suffix ? input.plan.normalizedQuery.toLowerCase() : rankQuery;
  const compact = compactQuery(query);
  const search: IndexQuery = {
    suffix,
    rankQuery,
    query,
    compact,
    mask: characterMask(compact),
    rootPrefix: input.root.endsWith(path.sep) ? input.root : input.root + path.sep,
  };
  const best: RankedEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === "directory" ? !input.includeDirectories : !input.includeFiles) continue;
    if (!mayMatch(entry, compact, search.mask)) continue;
    const worst = best.length === input.limit ? best[best.length - 1] : null;
    if (worst && onlyFallbackMatch(entry, worst, input, search)) continue;
    const fields = rankFields(entry.relativePath, entry.lowerPath, input, rankQuery);
    if (!matchesIndexQuery(entry, fields, input, search)) continue;
    if (worst && compareFields(fields, entry.kind, worst) > 0) continue;
    const ranked = { path: indexedVisiblePath(entry, search), kind: entry.kind, ...fields };
    keepBest(best, ranked, input.limit, compareRank);
  }
  return best;
}

function onlyFallbackMatch(
  entry: IndexedEntry,
  worst: RankedEntry,
  input: SearchInput,
  search: IndexQuery,
): boolean {
  return (
    worst.matchTier < FALLBACK_TIER &&
    entry.ascii &&
    !search.suffix &&
    !input.plan.isPathQuery &&
    !entry.lowerPath.includes(search.rankQuery) &&
    !containsCompact(entry.lowerPath, search.compact)
  );
}

function matchesIndexQuery(
  entry: IndexedEntry,
  fields: RankedFields,
  input: SearchInput,
  search: IndexQuery,
): boolean {
  if (!input.plan.normalizedQuery) return true;
  return search.suffix
    ? suffixMatchesRelative(entry.lowerPath, search.query)
    : fields.matchTier !== NO_MATCH_TIER;
}

function indexedVisiblePath(entry: IndexedEntry, search: IndexQuery): string {
  const relative =
    path.sep === "/" ? entry.relativePath : entry.relativePath.replaceAll("/", path.sep);
  return search.rootPrefix + relative;
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
    staysInsideRoot(child, input.root),
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

// Only a symlink can resolve outside the tree being walked. Every other child is its parent's
// path plus a name, and the parent was already proved inside the root.
function staysInsideRoot(entry: ChildEntry, root: string): boolean {
  return !entry.viaSymlink || isPathInsideRoot(root, entry.resolvedPath);
}

function shouldDiscover(entry: ChildEntry, input: SearchInput): boolean {
  if (isNewlyGitIgnored(entry, input)) return false;
  if (isNewlyExcluded(entry, input)) return false;
  if (entry.kind === "file") {
    return input.includeFiles && !entry.name.startsWith(".");
  }
  if (IGNORED_DIRECTORY_NAMES.has(entry.name)) return false;
  if (!entry.name.startsWith(".")) return true;
  return input.hiddenDirectoryNames.has(entry.name);
}

// Traversal only descends through entries that already passed this check, so every ancestor of
// a named child is known discoverable and only the entry itself can be newly ignored. A symlink
// resolves to a path with different ancestors, so it still needs the full walk.
function isNewlyGitIgnored(entry: ChildEntry, input: SearchInput): boolean {
  if (entry.viaSymlink) return isGitIgnoredPath(entry.resolvedPath, input);
  return input.gitIgnoredPaths.has(entry.resolvedPath);
}

// Same reasoning as Git-ignored paths: only a symlink can land inside an excluded path without
// first passing through it by name.
function isNewlyExcluded(entry: ChildEntry, input: SearchInput): boolean {
  if (input.excludedDiscoveryPaths.size === 0) return false;
  if (entry.viaSymlink) return isInsideExcludedPath(entry.resolvedPath, input);
  return input.excludedDiscoveryPaths.has(entry.resolvedPath);
}

function isInsideExcludedPath(absolutePath: string, input: SearchInput): boolean {
  for (const excludedPath of input.excludedDiscoveryPaths) {
    if (isPathInsideRoot(excludedPath, absolutePath)) return true;
  }
  return false;
}

function isGitIgnoredPath(absolutePath: string, input: SearchInput): boolean {
  let candidate = absolutePath;
  while (candidate !== input.root && isPathInsideRoot(input.root, candidate)) {
    if (input.gitIgnoredPaths.has(candidate)) return true;
    candidate = path.dirname(candidate);
  }
  return false;
}

function shouldSuggest(entry: TraversedEntry, input: SearchInput): boolean {
  if (entry.name.startsWith(".")) return false;
  if (entry.kind === "directory" && !input.includeDirectories) return false;
  if (entry.kind === "file" && !input.includeFiles) return false;
  if (!input.plan.normalizedQuery) return true;
  if (input.matchMode === "suffix")
    return suffixMatches(entry.visiblePath, input.root, input.plan.normalizedQuery);
  return rank(entry, input).matchTier !== NO_MATCH_TIER;
}

function rank(entry: TraversedEntry, input: SearchInput): RankedEntry {
  const relativePath = normalizeRelativePath(input.root, entry.visiblePath);
  const fields = rankFields(relativePath, relativePath.toLowerCase(), input, getRankQuery(input));
  return { path: entry.visiblePath, kind: entry.kind, ...fields };
}

interface RankedFields extends RankFields {
  depth: number;
}

function rankFields(
  relativePath: string,
  lowerPath: string,
  input: SearchInput,
  query: string,
): RankedFields {
  const fields = input.plan.isPathQuery
    ? rankPathMatch(query ? scorePathMatch(query, relativePath) : null)
    : rankTextMatch(query, relativePath, lowerPath, input.pathFormat);
  return { ...fields, depth: relativePath === "." ? 0 : countSegments(lowerPath) };
}

function countSegments(lowerPath: string): number {
  let count = 1;
  for (let index = lowerPath.indexOf("/"); index >= 0; index = lowerPath.indexOf("/", index + 1)) {
    count += 1;
  }
  return count;
}

function getRankQuery(input: SearchInput): string {
  return (
    input.plan.isPathQuery ? input.plan.normalizedQuery : input.plan.searchTerm
  ).toLowerCase();
}

function rankPathMatch(pathScore: MatchScore | null): RankFields {
  return {
    matchTier: pathScore ? Math.min(pathScore.tier, 4) : NO_MATCH_TIER,
    segmentIndex: NO_SEGMENT_INDEX,
    matchOffset: pathScore?.offset ?? NO_MATCH_OFFSET,
    fuzzyScore: pathScore?.spread ?? NO_FUZZY_SCORE,
  };
}

function rankTextMatch(
  query: string,
  relativePath: string,
  lowerPath: string,
  pathFormat: DirectorySuggestionPathFormat,
): RankFields {
  const offset = lowerPath.indexOf(query);
  const lastSegment = lowerPath === "." ? "" : lowerPath.slice(lowerPath.lastIndexOf("/") + 1);
  const fuzzyScore = scoreFuzzySubsequence(query, lastSegment);
  if (!query) {
    return {
      matchTier: 3,
      segmentIndex: NO_SEGMENT_INDEX,
      matchOffset: NO_MATCH_OFFSET,
      fuzzyScore: NO_FUZZY_SCORE,
    };
  }
  const segmentRank = offset >= 0 ? rankSegmentMatch(query, lowerPath, offset, fuzzyScore) : null;
  if (segmentRank) return segmentRank;
  if (pathFormat === "relative" ? lowerPath.startsWith(query) : offset >= 0) {
    return {
      matchTier: 3,
      segmentIndex: NO_SEGMENT_INDEX,
      matchOffset: offset,
      fuzzyScore: fuzzyScore ?? NO_FUZZY_SCORE,
    };
  }
  if (fuzzyScore !== null) {
    return {
      matchTier: 4,
      segmentIndex: NO_SEGMENT_INDEX,
      matchOffset: offset >= 0 ? offset : NO_MATCH_OFFSET,
      fuzzyScore,
    };
  }
  return rankPathMatch(scorePathMatch(query, relativePath));
}

function rankSegmentMatch(
  query: string,
  lowerPath: string,
  offset: number,
  fuzzyScore: number | null,
): RankFields | null {
  if (lowerPath === "." || query.includes("/")) return null;
  let exact = -1;
  let prefix = -1;
  let substring = -1;
  let segment = 0;
  let start = 0;
  while (exact < 0) {
    const separator = lowerPath.indexOf("/", start);
    const end = separator < 0 ? lowerPath.length : separator;
    const startsWithQuery = end - start >= query.length && lowerPath.startsWith(query, start);
    if (startsWithQuery && end - start === query.length) exact = segment;
    if (startsWithQuery && prefix < 0) prefix = segment;
    if (substring < 0) {
      const found = lowerPath.indexOf(query, start);
      if (found >= 0 && found + query.length <= end) substring = segment;
    }
    if (separator < 0) break;
    start = separator + 1;
    segment += 1;
  }
  const found = [exact, prefix, substring];
  const matchTier = found.findIndex((index) => index >= 0);
  if (matchTier < 0) return null;
  return {
    matchTier,
    segmentIndex: found[matchTier],
    matchOffset: offset,
    fuzzyScore: fuzzyScore ?? NO_FUZZY_SCORE,
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
  return compareFields(left, left.kind, right) || left.path.localeCompare(right.path);
}

function compareFields(
  left: RankedFields,
  kind: DirectorySuggestionKind,
  right: RankedEntry,
): number {
  return (
    left.matchTier - right.matchTier ||
    left.segmentIndex - right.segmentIndex ||
    left.matchOffset - right.matchOffset ||
    left.fuzzyScore - right.fuzzyScore ||
    left.depth - right.depth ||
    compareKinds(kind, right.kind)
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
  return suffixMatchesRelative(normalizeRelativePath(root, visiblePath).toLowerCase(), query);
}

function suffixMatchesRelative(lowerRelativePath: string, query: string): boolean {
  const querySegments = query.toLowerCase().split("/").filter(Boolean);
  if (querySegments.length === 0) return false;
  const pathSegments = lowerRelativePath.split("/").filter(Boolean);
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
    const dirents = await readdir(directory).catch(() => [] as Dirent[]);
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

async function loadGitIgnoredPaths(root: string): Promise<Set<string>> {
  const now = Date.now();
  const cached = gitIgnoredPathsCache.get(root);
  if (cached && cached.expiresAt > now) return cached.paths;

  const paths = runGitCommand(["ls-files", "-o", "-i", "--directory", "--exclude-standard", "-z"], {
    cwd: root,
    envOverlay: { GIT_OPTIONAL_LOCKS: "0" },
    timeout: 10_000,
  })
    .then(
      (result) =>
        new Set(
          result.stdout
            .split("\0")
            .filter(Boolean)
            .map((relativePath) => path.resolve(root, relativePath.replace(/\/$/, ""))),
        ),
    )
    .catch(() => new Set<string>());

  gitIgnoredPathsCache.set(root, {
    expiresAt: now + GIT_IGNORED_PATHS_CACHE_TTL_MS,
    paths,
  });
  pruneGitIgnoredPathsCache(now);
  return paths;
}

function pruneGitIgnoredPathsCache(now: number): void {
  if (gitIgnoredPathsCache.size <= GIT_IGNORED_PATHS_CACHE_MAX_ENTRIES) return;
  for (const [key, entry] of gitIgnoredPathsCache) {
    if (entry.expiresAt <= now) gitIgnoredPathsCache.delete(key);
  }
  while (gitIgnoredPathsCache.size > GIT_IGNORED_PATHS_CACHE_MAX_ENTRIES) {
    const key = gitIgnoredPathsCache.keys().next().value;
    if (!key) return;
    gitIgnoredPathsCache.delete(key);
  }
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
    return { name: entry.name, resolvedPath: visiblePath, kind: entry.kind, viaSymlink: false };
  }

  const resolvedPath = await realpath(visiblePath).catch(() => null);
  if (!resolvedPath) return null;
  const info = await stat(resolvedPath).catch(() => null);
  const kind = getEntryKind(info);
  return kind ? { name: entry.name, resolvedPath, kind, viaSymlink: true } : null;
}

function getEntryKind(info: Stats | null): DirectorySuggestionKind | null {
  if (info?.isDirectory()) return "directory";
  if (info?.isFile()) return "file";
  return null;
}

// Reads already reject stale entries by expiry and by directory metadata, so this only has to
// bound the map. Sweeping it for expired keys would cost a full pass on every cache miss.
function pruneCache(): void {
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

function sameEntry(left: DirectorySuggestionEntry, right: DirectorySuggestionEntry): boolean {
  return left.path === right.path && left.kind === right.kind;
}
