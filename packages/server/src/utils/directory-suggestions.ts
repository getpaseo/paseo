import type { Dirent } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

export interface SearchHomeDirectoriesOptions {
  homeDir: string
  query: string
  limit?: number
  maxDepth?: number
  maxDirectoriesScanned?: number
}

export interface GitRepoEntry {
  path: string
  kind: 'directory'
  isGitRepo: true
}

export type WorkspaceSuggestionKind = 'file' | 'directory'

export interface WorkspaceSuggestionEntry {
  path: string
  kind: WorkspaceSuggestionKind
}

export interface SearchWorkspaceEntriesOptions {
  cwd: string
  query: string
  limit?: number
  includeFiles?: boolean
  includeDirectories?: boolean
  maxDepth?: number
  maxEntriesScanned?: number
}

const DEFAULT_LIMIT = 30
const MAX_LIMIT = 100
const DEFAULT_MAX_DEPTH = 6
const DEFAULT_MAX_DIRECTORIES_SCANNED = 5000
const DIRECTORY_LIST_CACHE_TTL_MS = 8_000
const DIRECTORY_LIST_CACHE_MAX_ENTRIES = 4_000

type QueryParts = {
  isPathQuery: boolean
  parentPart: string
  searchTerm: string
}

type RankedDirectory = {
  absolutePath: string
  matchTier: number
  segmentIndex: number
  matchOffset: number
  depth: number
}

type ChildDirectoryEntry = {
  name: string
  absolutePath: string
}

type ChildWorkspaceEntry = {
  name: string
  absolutePath: string
  kind: WorkspaceSuggestionKind
}

type DirectoryListCacheEntry = {
  expiresAt: number
  entries: ChildDirectoryEntry[]
}

type WorkspaceEntryListCacheEntry = {
  expiresAt: number
  entries: ChildWorkspaceEntry[]
}

const directoryListCache = new Map<string, DirectoryListCacheEntry>()
const workspaceEntryListCache = new Map<string, WorkspaceEntryListCacheEntry>()
const NO_SEGMENT_INDEX = Number.MAX_SAFE_INTEGER
const NO_MATCH_OFFSET = Number.MAX_SAFE_INTEGER
const WORKSPACE_IGNORED_DIRECTORY_NAMES = new Set(['node_modules'])

export async function searchHomeDirectories(
  options: SearchHomeDirectoriesOptions
): Promise<string[]> {
  const query = options.query.trim()
  if (!query) {
    return []
  }

  const limit = normalizeLimit(options.limit)
  const homeRoot = await resolveDirectory(options.homeDir)
  if (!homeRoot) {
    return []
  }

  const queryParts = normalizeQueryParts(query, homeRoot)
  if (!queryParts) {
    return []
  }

  if (queryParts.isPathQuery) {
    return searchWithinParentDirectory({
      homeRoot,
      parentPart: queryParts.parentPart,
      searchTerm: queryParts.searchTerm,
      limit,
    })
  }

  return searchAcrossHomeTree({
    homeRoot,
    searchTerm: queryParts.searchTerm,
    limit,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxDirectoriesScanned: options.maxDirectoriesScanned ?? DEFAULT_MAX_DIRECTORIES_SCANNED,
  })
}

type RankedWorkspaceEntry = {
  relativePath: string
  kind: WorkspaceSuggestionKind
  matchTier: number
  segmentIndex: number
  matchOffset: number
  depth: number
}

export async function searchWorkspaceEntries(
  options: SearchWorkspaceEntriesOptions
): Promise<WorkspaceSuggestionEntry[]> {
  const limit = normalizeLimit(options.limit)
  const includeDirectories = options.includeDirectories ?? true
  const includeFiles = options.includeFiles ?? false
  if (!includeDirectories && !includeFiles) {
    return []
  }

  const workspaceRoot = await resolveDirectory(options.cwd)
  if (!workspaceRoot) {
    return []
  }

  const queryParts = normalizeWorkspaceQueryParts(options.query, workspaceRoot)
  if (!queryParts) {
    return []
  }

  if (queryParts.isPathQuery) {
    return searchWorkspaceWithinParentDirectory({
      workspaceRoot,
      parentPart: queryParts.parentPart,
      searchTerm: queryParts.searchTerm,
      limit,
      includeDirectories,
      includeFiles,
    })
  }

  return searchWorkspaceAcrossTree({
    workspaceRoot,
    searchTerm: queryParts.searchTerm,
    limit,
    includeDirectories,
    includeFiles,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxEntriesScanned: options.maxEntriesScanned ?? DEFAULT_MAX_DIRECTORIES_SCANNED,
  })
}

function normalizeLimit(limit: number | undefined): number {
  const candidate = limit ?? DEFAULT_LIMIT
  if (!Number.isFinite(candidate)) {
    return DEFAULT_LIMIT
  }
  const bounded = Math.trunc(candidate)
  return Math.max(1, Math.min(MAX_LIMIT, bounded))
}

async function searchWithinParentDirectory(input: {
  homeRoot: string
  parentPart: string
  searchTerm: string
  limit: number
}): Promise<string[]> {
  const parentPath = path.resolve(input.homeRoot, input.parentPart || '.')
  const parentRoot = await resolveDirectory(parentPath)
  if (!parentRoot || !isPathInsideRoot(input.homeRoot, parentRoot)) {
    return []
  }

  const searchLower = input.searchTerm.toLowerCase()
  const ranked: RankedDirectory[] = []
  const entries = await listChildDirectories({
    directory: parentRoot,
    homeRoot: input.homeRoot,
  })

  for (const entry of entries) {
    if (searchLower && !entry.name.toLowerCase().includes(searchLower)) {
      continue
    }

    ranked.push(
      rankDirectory({
        absolutePath: entry.absolutePath,
        homeRoot: input.homeRoot,
        searchLower,
      })
    )
  }

  return dedupeAndSort(ranked).slice(0, input.limit)
}

async function searchAcrossHomeTree(input: {
  homeRoot: string
  searchTerm: string
  limit: number
  maxDepth: number
  maxDirectoriesScanned: number
}): Promise<string[]> {
  const queue: Array<{ directory: string; depth: number }> = [
    { directory: input.homeRoot, depth: 0 },
  ]
  const visited = new Set<string>([input.homeRoot])
  const ranked: RankedDirectory[] = []
  let scanned = 0
  const searchLower = input.searchTerm.toLowerCase()

  for (
    let queueIndex = 0;
    queueIndex < queue.length && scanned < input.maxDirectoriesScanned;
    queueIndex += 1
  ) {
    const current = queue[queueIndex]
    if (!current) continue
    const entries = await listChildDirectories({
      directory: current.directory,
      homeRoot: input.homeRoot,
    })

    for (const entry of entries) {
      const resolvedCandidate = entry.absolutePath
      if (visited.has(resolvedCandidate)) {
        continue
      }
      visited.add(resolvedCandidate)
      scanned += 1

      const relativePath = normalizeRelativePath(input.homeRoot, resolvedCandidate)
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
        )
      }

      if (current.depth < input.maxDepth && scanned < input.maxDirectoriesScanned) {
        queue.push({ directory: resolvedCandidate, depth: current.depth + 1 })
      }
    }
  }

  return dedupeAndSort(ranked).slice(0, input.limit)
}

async function searchWorkspaceWithinParentDirectory(input: {
  workspaceRoot: string
  parentPart: string
  searchTerm: string
  limit: number
  includeDirectories: boolean
  includeFiles: boolean
}): Promise<WorkspaceSuggestionEntry[]> {
  const parentPath = path.resolve(input.workspaceRoot, input.parentPart || '.')
  const parentRoot = await resolveDirectory(parentPath)
  if (!parentRoot || !isPathInsideRoot(input.workspaceRoot, parentRoot)) {
    return []
  }

  const searchLower = input.searchTerm.toLowerCase()
  const ranked: RankedWorkspaceEntry[] = []
  const entries = await listWorkspaceChildEntries({
    directory: parentRoot,
    workspaceRoot: input.workspaceRoot,
  })

  for (const entry of entries) {
    if (entry.kind === 'directory' && !input.includeDirectories) {
      continue
    }
    if (entry.kind === 'file' && !input.includeFiles) {
      continue
    }
    if (searchLower && !entry.name.toLowerCase().includes(searchLower)) {
      continue
    }

    ranked.push(
      rankWorkspaceEntry({
        absolutePath: entry.absolutePath,
        kind: entry.kind,
        workspaceRoot: input.workspaceRoot,
        searchLower,
      })
    )
  }

  return dedupeAndSortWorkspaceEntries(ranked).slice(0, input.limit)
}

async function searchWorkspaceAcrossTree(input: {
  workspaceRoot: string
  searchTerm: string
  limit: number
  includeDirectories: boolean
  includeFiles: boolean
  maxDepth: number
  maxEntriesScanned: number
}): Promise<WorkspaceSuggestionEntry[]> {
  const queue: Array<{ directory: string; depth: number }> = [
    { directory: input.workspaceRoot, depth: 0 },
  ]
  const visited = new Set<string>([input.workspaceRoot])
  const ranked: RankedWorkspaceEntry[] = []
  let scanned = 0
  const searchLower = input.searchTerm.toLowerCase()

  for (
    let queueIndex = 0;
    queueIndex < queue.length && scanned < input.maxEntriesScanned;
    queueIndex += 1
  ) {
    const current = queue[queueIndex]
    if (!current) continue

    const entries = await listWorkspaceChildEntries({
      directory: current.directory,
      workspaceRoot: input.workspaceRoot,
    })

    for (const entry of entries) {
      scanned += 1

      if (entry.kind === 'directory') {
        if (
          !visited.has(entry.absolutePath) &&
          current.depth < input.maxDepth &&
          scanned < input.maxEntriesScanned
        ) {
          visited.add(entry.absolutePath)
          queue.push({
            directory: entry.absolutePath,
            depth: current.depth + 1,
          })
        }
      }

      if (entry.kind === 'directory' && !input.includeDirectories) {
        continue
      }
      if (entry.kind === 'file' && !input.includeFiles) {
        continue
      }

      const relativePath = normalizeRelativePath(input.workspaceRoot, entry.absolutePath)
      if (
        searchLower &&
        !relativePath.toLowerCase().includes(searchLower) &&
        !entry.name.toLowerCase().includes(searchLower)
      ) {
        continue
      }

      ranked.push(
        rankWorkspaceEntry({
          absolutePath: entry.absolutePath,
          kind: entry.kind,
          workspaceRoot: input.workspaceRoot,
          searchLower,
        })
      )
    }
  }

  return dedupeAndSortWorkspaceEntries(ranked).slice(0, input.limit)
}

function dedupeAndSortWorkspaceEntries(
  rankedEntries: RankedWorkspaceEntry[]
): WorkspaceSuggestionEntry[] {
  const byPath = new Map<string, RankedWorkspaceEntry>()
  for (const entry of rankedEntries) {
    const key = `${entry.kind}:${entry.relativePath}`
    const existing = byPath.get(key)
    if (!existing || compareRankedWorkspaceEntries(entry, existing) < 0) {
      byPath.set(key, entry)
    }
  }

  return Array.from(byPath.values())
    .sort(compareRankedWorkspaceEntries)
    .map((entry) => ({
      path: entry.relativePath,
      kind: entry.kind,
    }))
}

function compareRankedWorkspaceEntries(
  left: RankedWorkspaceEntry,
  right: RankedWorkspaceEntry
): number {
  if (left.matchTier !== right.matchTier) {
    return left.matchTier - right.matchTier
  }
  if (left.segmentIndex !== right.segmentIndex) {
    return left.segmentIndex - right.segmentIndex
  }
  if (left.matchOffset !== right.matchOffset) {
    return left.matchOffset - right.matchOffset
  }
  if (left.depth !== right.depth) {
    return left.depth - right.depth
  }
  if (left.kind !== right.kind) {
    return left.kind === 'directory' ? -1 : 1
  }
  return left.relativePath.localeCompare(right.relativePath)
}

function dedupeAndSort(ranked: RankedDirectory[]): string[] {
  const byPath = new Map<string, RankedDirectory>()
  for (const entry of ranked) {
    const existing = byPath.get(entry.absolutePath)
    if (!existing || compareRankedDirectories(entry, existing) < 0) {
      byPath.set(entry.absolutePath, entry)
    }
  }

  return Array.from(byPath.values())
    .sort(compareRankedDirectories)
    .map((entry) => entry.absolutePath)
}

function compareRankedDirectories(left: RankedDirectory, right: RankedDirectory): number {
  if (left.matchTier !== right.matchTier) {
    return left.matchTier - right.matchTier
  }
  if (left.segmentIndex !== right.segmentIndex) {
    return left.segmentIndex - right.segmentIndex
  }
  if (left.matchOffset !== right.matchOffset) {
    return left.matchOffset - right.matchOffset
  }
  if (left.depth !== right.depth) {
    return left.depth - right.depth
  }
  return left.absolutePath.localeCompare(right.absolutePath)
}

function rankDirectory(input: {
  absolutePath: string
  homeRoot: string
  searchLower: string
}): RankedDirectory {
  const relative = normalizeRelativePath(input.homeRoot, input.absolutePath)
  const relativeLower = relative.toLowerCase()
  const depth = relative === '.' ? 0 : relative.split('/').length
  const searchLower = input.searchLower
  if (!searchLower) {
    return {
      absolutePath: input.absolutePath,
      matchTier: 3,
      segmentIndex: NO_SEGMENT_INDEX,
      matchOffset: 0,
      depth,
    }
  }
  const segments = relativeLower === '.' ? [] : relativeLower.split('/')
  const exactSegmentIndex = findSegmentMatchIndex(segments, (segment) => segment === searchLower)
  const prefixSegmentIndex = findSegmentMatchIndex(segments, (segment) =>
    segment.startsWith(searchLower)
  )
  const partialSegmentIndex = findSegmentMatchIndex(segments, (segment) =>
    segment.includes(searchLower)
  )
  const matchOffset = relativeLower.indexOf(searchLower)
  let matchTier = 4
  let segmentIndex = NO_SEGMENT_INDEX

  if (exactSegmentIndex >= 0) {
    matchTier = 0
    segmentIndex = exactSegmentIndex
  } else if (prefixSegmentIndex >= 0) {
    matchTier = 1
    segmentIndex = prefixSegmentIndex
  } else if (partialSegmentIndex >= 0) {
    matchTier = 2
    segmentIndex = partialSegmentIndex
  } else if (relativeLower.startsWith(searchLower)) {
    matchTier = 3
  }

  return {
    absolutePath: input.absolutePath,
    matchTier,
    segmentIndex,
    matchOffset: matchOffset >= 0 ? matchOffset : NO_MATCH_OFFSET,
    depth,
  }
}

function rankWorkspaceEntry(input: {
  absolutePath: string
  kind: WorkspaceSuggestionKind
  workspaceRoot: string
  searchLower: string
}): RankedWorkspaceEntry {
  const relativePath = normalizeRelativePath(input.workspaceRoot, input.absolutePath)
  const relativeLower = relativePath.toLowerCase()
  const depth = relativePath === '.' ? 0 : relativePath.split('/').length
  const searchLower = input.searchLower
  if (!searchLower) {
    return {
      relativePath,
      kind: input.kind,
      matchTier: 3,
      segmentIndex: NO_SEGMENT_INDEX,
      matchOffset: 0,
      depth,
    }
  }

  const segments = relativeLower === '.' ? [] : relativeLower.split('/')
  const exactSegmentIndex = findSegmentMatchIndex(segments, (segment) => segment === searchLower)
  const prefixSegmentIndex = findSegmentMatchIndex(segments, (segment) =>
    segment.startsWith(searchLower)
  )
  const partialSegmentIndex = findSegmentMatchIndex(segments, (segment) =>
    segment.includes(searchLower)
  )
  const matchOffset = relativeLower.indexOf(searchLower)
  let matchTier = 4
  let segmentIndex = NO_SEGMENT_INDEX

  if (exactSegmentIndex >= 0) {
    matchTier = 0
    segmentIndex = exactSegmentIndex
  } else if (prefixSegmentIndex >= 0) {
    matchTier = 1
    segmentIndex = prefixSegmentIndex
  } else if (partialSegmentIndex >= 0) {
    matchTier = 2
    segmentIndex = partialSegmentIndex
  } else if (relativeLower.startsWith(searchLower)) {
    matchTier = 3
  }

  return {
    relativePath,
    kind: input.kind,
    matchTier,
    segmentIndex,
    matchOffset: matchOffset >= 0 ? matchOffset : NO_MATCH_OFFSET,
    depth,
  }
}

function findSegmentMatchIndex(
  segments: string[],
  predicate: (segment: string) => boolean
): number {
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]
    if (!segment) {
      continue
    }
    if (predicate(segment)) {
      return index
    }
  }
  return -1
}

function normalizeRelativePath(homeRoot: string, absolutePath: string): string {
  const relative = path.relative(homeRoot, absolutePath)
  if (!relative) {
    return '.'
  }
  return relative.split(path.sep).join('/')
}

function isPathInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function normalizeQueryParts(query: string, homeRoot: string): QueryParts | null {
  const typedQuery = query.trim().replace(/\\/g, '/')
  let normalized = typedQuery
  if (!normalized) {
    return null
  }

  if (normalized.startsWith('~')) {
    normalized = normalized.slice(1)
    if (normalized.startsWith('/')) {
      normalized = normalized.slice(1)
    }
  }

  if (path.isAbsolute(normalized)) {
    const absolute = path.resolve(normalized)
    if (!isPathInsideRoot(homeRoot, absolute)) {
      return null
    }
    normalized = normalizeRelativePath(homeRoot, absolute)
  }

  normalized = normalized.replace(/^\.\/+/, '').replace(/\/{2,}/g, '/')
  if (!normalized) {
    // Treat "~" and "~/" as a request to browse the home root.
    if (typedQuery === '~' || typedQuery === '~/') {
      return {
        isPathQuery: true,
        parentPart: '',
        searchTerm: '',
      }
    }
    return null
  }

  const isPathQuery = normalized.includes('/')
  const slashIndex = normalized.lastIndexOf('/')
  const parentPart = slashIndex >= 0 ? normalized.slice(0, slashIndex) : ''
  const searchTerm = slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized

  return {
    isPathQuery,
    parentPart,
    searchTerm,
  }
}

function normalizeWorkspaceQueryParts(query: string, workspaceRoot: string): QueryParts | null {
  let normalized = query.trim().replace(/\\/g, '/')

  if (path.isAbsolute(normalized)) {
    const absolute = path.resolve(normalized)
    if (!isPathInsideRoot(workspaceRoot, absolute)) {
      return null
    }
    normalized = normalizeRelativePath(workspaceRoot, absolute)
  }

  normalized = normalized.replace(/^\.\/+/, '').replace(/\/{2,}/g, '/')
  if (!normalized) {
    return {
      isPathQuery: true,
      parentPart: '',
      searchTerm: '',
    }
  }

  const isPathQuery = normalized.includes('/')
  const slashIndex = normalized.lastIndexOf('/')
  const parentPart = slashIndex >= 0 ? normalized.slice(0, slashIndex) : ''
  const searchTerm = slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized

  return {
    isPathQuery,
    parentPart,
    searchTerm,
  }
}

async function resolveDirectory(inputPath: string): Promise<string | null> {
  try {
    const resolved = await realpath(path.resolve(inputPath))
    const stats = await stat(resolved)
    if (!stats.isDirectory()) {
      return null
    }
    return resolved
  } catch {
    return null
  }
}

async function listChildDirectories(input: {
  directory: string
  homeRoot: string
}): Promise<ChildDirectoryEntry[]> {
  const now = Date.now()
  const cached = directoryListCache.get(input.directory)
  if (cached && cached.expiresAt > now) {
    return cached.entries
  }

  const dirents = await readdir(input.directory, { withFileTypes: true }).catch(
    () => [] as Dirent[]
  )
  const entries: ChildDirectoryEntry[] = []
  for (const dirent of dirents) {
    if (isHiddenDirectoryName(dirent.name)) {
      continue
    }
    if (!dirent.isDirectory() && !dirent.isSymbolicLink()) {
      continue
    }
    const candidatePath = path.join(input.directory, dirent.name)
    const absolutePath = await resolveDirectoryCandidate({
      candidatePath,
      dirent,
      homeRoot: input.homeRoot,
    })
    if (!absolutePath) {
      continue
    }
    entries.push({
      name: dirent.name,
      absolutePath,
    })
  }

  setDirectoryListCache(input.directory, {
    expiresAt: now + DIRECTORY_LIST_CACHE_TTL_MS,
    entries,
  })

  return entries
}

async function listWorkspaceChildEntries(input: {
  directory: string
  workspaceRoot: string
}): Promise<ChildWorkspaceEntry[]> {
  const now = Date.now()
  const cached = workspaceEntryListCache.get(input.directory)
  if (cached && cached.expiresAt > now) {
    return cached.entries
  }

  const dirents = await readdir(input.directory, { withFileTypes: true }).catch(
    () => [] as Dirent[]
  )
  const entries: ChildWorkspaceEntry[] = []
  for (const dirent of dirents) {
    if (isHiddenDirectoryName(dirent.name)) {
      continue
    }
    if (isIgnoredWorkspaceDirectoryName(dirent.name)) {
      continue
    }

    const candidatePath = path.join(input.directory, dirent.name)
    const entry = await resolveWorkspaceCandidate({
      candidatePath,
      dirent,
      workspaceRoot: input.workspaceRoot,
    })
    if (!entry) {
      continue
    }
    entries.push({
      name: dirent.name,
      absolutePath: entry.absolutePath,
      kind: entry.kind,
    })
  }

  setWorkspaceEntryListCache(input.directory, {
    expiresAt: now + DIRECTORY_LIST_CACHE_TTL_MS,
    entries,
  })

  return entries
}

async function resolveDirectoryCandidate(input: {
  candidatePath: string
  dirent: Dirent
  homeRoot: string
}): Promise<string | null> {
  if (input.dirent.isDirectory()) {
    const resolved = path.resolve(input.candidatePath)
    return isPathInsideRoot(input.homeRoot, resolved) ? resolved : null
  }

  const resolved = await resolveDirectory(input.candidatePath)
  if (!resolved || !isPathInsideRoot(input.homeRoot, resolved)) {
    return null
  }
  return resolved
}

async function resolveWorkspaceCandidate(input: {
  candidatePath: string
  dirent: Dirent
  workspaceRoot: string
}): Promise<{ absolutePath: string; kind: WorkspaceSuggestionKind } | null> {
  if (input.dirent.isDirectory()) {
    const resolved = path.resolve(input.candidatePath)
    if (!isPathInsideRoot(input.workspaceRoot, resolved)) {
      return null
    }
    return { absolutePath: resolved, kind: 'directory' }
  }

  if (input.dirent.isFile()) {
    const resolved = path.resolve(input.candidatePath)
    if (!isPathInsideRoot(input.workspaceRoot, resolved)) {
      return null
    }
    return { absolutePath: resolved, kind: 'file' }
  }

  if (!input.dirent.isSymbolicLink()) {
    return null
  }

  try {
    const resolved = await realpath(input.candidatePath)
    if (!isPathInsideRoot(input.workspaceRoot, resolved)) {
      return null
    }
    const stats = await stat(resolved)
    if (stats.isDirectory()) {
      return { absolutePath: resolved, kind: 'directory' }
    }
    if (stats.isFile()) {
      return { absolutePath: resolved, kind: 'file' }
    }
    return null
  } catch {
    return null
  }
}

function isHiddenDirectoryName(name: string): boolean {
  return name.startsWith('.')
}

function isIgnoredWorkspaceDirectoryName(name: string): boolean {
  return WORKSPACE_IGNORED_DIRECTORY_NAMES.has(name)
}

function setDirectoryListCache(cacheKey: string, entry: DirectoryListCacheEntry): void {
  directoryListCache.set(cacheKey, entry)
  pruneDirectoryListCache()
}

function setWorkspaceEntryListCache(cacheKey: string, entry: WorkspaceEntryListCacheEntry): void {
  workspaceEntryListCache.set(cacheKey, entry)
  pruneWorkspaceEntryListCache()
}

function pruneDirectoryListCache(): void {
  if (directoryListCache.size <= DIRECTORY_LIST_CACHE_MAX_ENTRIES) {
    return
  }

  const now = Date.now()
  for (const [cacheKey, entry] of directoryListCache) {
    if (entry.expiresAt <= now) {
      directoryListCache.delete(cacheKey)
    }
  }

  while (directoryListCache.size > DIRECTORY_LIST_CACHE_MAX_ENTRIES) {
    const oldestKey = directoryListCache.keys().next().value as string | undefined
    if (!oldestKey) {
      return
    }
    directoryListCache.delete(oldestKey)
  }
}

function pruneWorkspaceEntryListCache(): void {
  if (workspaceEntryListCache.size <= DIRECTORY_LIST_CACHE_MAX_ENTRIES) {
    return
  }

  const now = Date.now()
  for (const [cacheKey, entry] of workspaceEntryListCache) {
    if (entry.expiresAt <= now) {
      workspaceEntryListCache.delete(cacheKey)
    }
  }

  while (workspaceEntryListCache.size > DIRECTORY_LIST_CACHE_MAX_ENTRIES) {
    const oldestKey = workspaceEntryListCache.keys().next().value as string | undefined
    if (!oldestKey) {
      return
    }
    workspaceEntryListCache.delete(oldestKey)
  }
}

async function checkIsGitRepo(dirPath: string): Promise<boolean> {
  try {
    await stat(path.join(dirPath, '.git'))
    return true
  } catch {
    return false
  }
}

export async function searchGitRepositories(
  options: SearchHomeDirectoriesOptions
): Promise<GitRepoEntry[]> {
  const directories = await searchHomeDirectories(options)
  const results: GitRepoEntry[] = []
  const checks = await Promise.all(
    directories.map(async (dir) => ({
      dir,
      isGit: await checkIsGitRepo(dir),
    }))
  )
  for (const { dir, isGit } of checks) {
    if (isGit) {
      results.push({ path: dir, kind: 'directory', isGitRepo: true })
    }
  }
  return results
}
