import { type Dirent, type Stats } from "fs";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
} from "fs/promises";
import {
  basename as pathBasename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  win32,
} from "path";
import { areEquivalentPaths, isPathInsideRoot } from "./path.js";

const WORKTREE_INCLUDE_FILE_NAME = ".worktreeinclude";

export type WorktreeIncludeMode = "copy" | "symlink";
type WorktreeIncludeSourceKind = "file" | "directory";
type WorktreeIncludeErrorCode =
  | "conflict"
  | "invalid_entry"
  | "missing_source"
  | "source_changed"
  | "unsupported_source"
  | "windows_symlink_unavailable";

export type WorktreeIncludeSkipReason =
  | "conflict"
  | "invalid"
  | "materialization"
  | "missing"
  | "source_changed"
  | "unsafe";

interface WorktreeIncludeEntry {
  lineNumber: number;
  mode: WorktreeIncludeMode;
  raw: string;
  relativePath: string;
}

export interface WorktreeIncludeMaterialization {
  lineNumber: number;
  mode: WorktreeIncludeMode;
  raw: string;
  relativePath: string;
  sourceKind: WorktreeIncludeSourceKind;
}

export interface WorktreeIncludeSkippedEntry {
  lineNumber: number;
  message: string;
  raw: string;
  reason: WorktreeIncludeSkipReason;
}

export interface WorktreeIncludeSummary {
  materialized: number;
  skipped: WorktreeIncludeSkippedEntry[];
}

export interface WorktreeIncludePlan {
  excludedSourceRoots: string[];
  materializations: WorktreeIncludeMaterialization[];
  skipped: WorktreeIncludeSkippedEntry[];
  sourceRoot: string;
}

export interface ReadWorktreeIncludePlanOptions {
  excludedSourceRoots?: string[];
  sourceRoot: string;
}

export interface MaterializeWorktreeIncludePlanOptions {
  plan: WorktreeIncludePlan;
  worktreeRoot: string;
}

interface ResolvedWorktreeIncludeMaterialization {
  materialization: WorktreeIncludeMaterialization;
  sourcePath: string;
}

interface StagedWorktreeIncludeMaterialization {
  directoryPath: string;
  entryPath: string;
}

interface ParsedWorktreeIncludeEntries {
  entries: WorktreeIncludeEntry[];
  skipped: WorktreeIncludeSkippedEntry[];
}

interface NormalizedWorktreeIncludeMaterializations {
  materializations: WorktreeIncludeMaterialization[];
  skipped: WorktreeIncludeSkippedEntry[];
}

interface WorktreeIncludeCandidateCollection {
  candidates: string[];
  errorsByPattern: Map<string, unknown>;
}

export class WorktreeIncludeError extends Error {
  constructor(
    public readonly code: WorktreeIncludeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorktreeIncludeError";
  }
}

class WorktreeIncludeCleanupError extends Error {
  constructor(
    message: string,
    public readonly cleanupError: unknown,
  ) {
    super(message);
    this.name = "WorktreeIncludeCleanupError";
  }
}

export async function readWorktreeIncludePlan(
  options: ReadWorktreeIncludePlanOptions,
): Promise<WorktreeIncludePlan> {
  const sourceRoot = await realpath(options.sourceRoot);
  const { entries, skipped } = await readWorktreeIncludeEntries(sourceRoot);
  if (entries.length === 0) {
    return {
      sourceRoot,
      excludedSourceRoots: [],
      materializations: [],
      skipped,
    };
  }

  const excludedSourceRoots = (
    await Promise.all((options.excludedSourceRoots ?? []).map(canonicalizeExistingPathPrefix))
  ).filter((candidate) => !isPathInsideRoot(candidate, sourceRoot));
  const candidatePatterns = entries
    .filter(
      (entry) => entry.relativePath.includes("*") && getRecursiveDirectoryPath(entry) === null,
    )
    .map((entry) => entry.relativePath);
  const candidateCollection =
    candidatePatterns.length > 0
      ? await collectWorktreeIncludeCandidates({
          sourceRoot,
          excludedSourceRoots,
          patterns: candidatePatterns,
        })
      : { candidates: [], errorsByPattern: new Map<string, unknown>() };
  const materializations: WorktreeIncludeMaterialization[] = [];

  for (const entry of entries) {
    const matchedPaths = resolveEntryMatches({ entry, candidates: candidateCollection.candidates });
    const candidateError = candidateCollection.errorsByPattern.get(entry.relativePath);
    if (candidateError !== undefined) {
      skipped.push(toSkippedEntry(entry, candidateError));
      if (matchedPaths.length === 0) {
        continue;
      }
    }
    if (matchedPaths.length === 0) {
      skipped.push(toSkippedEntry(entry, noMatchError(entry)));
      continue;
    }

    for (const relativePath of matchedPaths) {
      try {
        const resolved = await resolveSourceMaterialization({
          entry,
          excludedSourceRoots,
          relativePath,
          sourceRoot,
        });
        materializations.push(resolved.materialization);
      } catch (error) {
        if (!isWorktreeIncludeMaterializationError(error)) {
          throw error;
        }
        skipped.push(toSkippedEntry(entry, error));
      }
    }
  }

  const normalized = normalizeMaterializations(materializations);

  return {
    excludedSourceRoots,
    materializations: normalized.materializations,
    skipped: [...skipped, ...normalized.skipped],
    sourceRoot,
  };
}

async function canonicalizeExistingPathPrefix(path: string): Promise<string> {
  const absolutePath = resolve(path);
  const missingSegments: string[] = [];
  let existingPath = absolutePath;

  while (true) {
    try {
      return join(await realpath(existingPath), ...missingSegments);
    } catch (error) {
      if (getErrorCode(error) !== "ENOENT" && getErrorCode(error) !== "ENOTDIR") {
        throw error;
      }

      const parentPath = dirname(existingPath);
      if (parentPath === existingPath) {
        return absolutePath;
      }
      missingSegments.unshift(pathBasename(existingPath));
      existingPath = parentPath;
    }
  }
}

export async function materializeWorktreeIncludePlan(
  options: MaterializeWorktreeIncludePlanOptions,
): Promise<WorktreeIncludeSummary> {
  const skipped: WorktreeIncludeSkippedEntry[] = [];
  let materialized = 0;
  if (options.plan.materializations.length === 0) {
    return { materialized, skipped };
  }

  const worktreeRoot = await realpath(options.worktreeRoot);
  for (const materialization of options.plan.materializations) {
    const entry = {
      lineNumber: materialization.lineNumber,
      mode: materialization.mode,
      raw: materialization.raw,
      relativePath: materialization.relativePath,
    };
    let resolved: ResolvedWorktreeIncludeMaterialization;
    try {
      resolved = await resolveSourceMaterialization({
        entry,
        excludedSourceRoots: options.plan.excludedSourceRoots,
        relativePath: materialization.relativePath,
        sourceRoot: options.plan.sourceRoot,
      });
    } catch (error) {
      if (isSkippableWorktreeIncludeError(error) || getErrorCode(error) !== null) {
        skipped.push(toSkippedEntry(entry, error));
        continue;
      }
      throw error;
    }
    if (resolved.materialization.sourceKind !== materialization.sourceKind) {
      skipped.push(
        toSkippedEntry(
          entry,
          new WorktreeIncludeError(
            "source_changed",
            `Source for .worktreeinclude entry '${materialization.raw}' changed type before it could be materialized`,
          ),
        ),
      );
      continue;
    }

    let staged: StagedWorktreeIncludeMaterialization | null = null;
    let createdDestinationParents: string[] = [];
    try {
      const destinationPath = getDestinationPath({
        worktreeRoot,
        relativePath: resolved.materialization.relativePath,
      });
      if (
        !(await preflightDestination({
          worktreeRoot,
          resolved,
        }))
      ) {
        materialized++;
        continue;
      }

      staged = await stageMaterialization({
        destinationPath,
        resolved,
        worktreeRoot,
      });
      createdDestinationParents = await ensureDestinationParent({
        worktreeRoot,
        relativePath: resolved.materialization.relativePath,
      });
      if (
        !(await preflightDestination({
          worktreeRoot,
          resolved,
        }))
      ) {
        await cleanupStagingDirectory(staged.directoryPath);
        staged = null;
        await cleanupCreatedDestinationParents(createdDestinationParents);
        materialized++;
        continue;
      }

      const destinationStats = await lstatIfExists(destinationPath);
      if (resolved.materialization.mode === "copy" && destinationStats !== null) {
        await copyStagedMaterializationToExistingDestination({
          destinationPath,
          resolved,
          staged,
        });
      } else {
        await rename(staged.entryPath, destinationPath);
      }

      await cleanupStagingDirectory(staged.directoryPath);
      staged = null;
      materialized++;
    } catch (error) {
      if (error instanceof WorktreeIncludeCleanupError) {
        throw error;
      }
      if (staged !== null) {
        await cleanupStagingDirectory(staged.directoryPath);
      }
      await cleanupCreatedDestinationParents(createdDestinationParents);
      if (isWorktreeIncludeMaterializationError(error)) {
        skipped.push(toSkippedEntry(entry, error));
        continue;
      }
      throw error;
    }
  }

  return { materialized, skipped };
}

async function stageMaterialization(options: {
  destinationPath: string;
  resolved: ResolvedWorktreeIncludeMaterialization;
  worktreeRoot: string;
}): Promise<StagedWorktreeIncludeMaterialization> {
  const directoryPath = await mkdtemp(join(options.worktreeRoot, ".paseo-worktreeinclude-"));
  const entryPath = join(directoryPath, "entry");
  try {
    if (options.resolved.materialization.mode === "copy") {
      await copyMaterializationPath({
        destinationPath: entryPath,
        sourceKind: options.resolved.materialization.sourceKind,
        sourcePath: options.resolved.sourcePath,
      });
      if (options.resolved.materialization.sourceKind === "directory") {
        const stagedStats = await lstat(entryPath);
        if (!stagedStats.isDirectory()) {
          throw new WorktreeIncludeError(
            "source_changed",
            `.worktreeinclude entry '${options.resolved.materialization.raw}' changed type while it was staged`,
          );
        }
        await assertCopyDirectorySafe({
          entry: options.resolved.materialization,
          sourcePath: entryPath,
        });
      }
    } else {
      await createMaterializationSymlink({
        destinationPath: entryPath,
        linkDestinationPath: options.destinationPath,
        resolved: options.resolved,
      });
    }
    return { directoryPath, entryPath };
  } catch (error) {
    await cleanupStagingDirectory(directoryPath);
    throw error;
  }
}

async function copyStagedMaterializationToExistingDestination(options: {
  destinationPath: string;
  resolved: ResolvedWorktreeIncludeMaterialization;
  staged: StagedWorktreeIncludeMaterialization;
}): Promise<void> {
  const backupPath = join(options.staged.directoryPath, "backup");
  await rename(options.destinationPath, backupPath);
  try {
    await rename(options.staged.entryPath, options.destinationPath);
  } catch (error) {
    await restoreCopiedDestination({
      backupPath,
      destinationPath: options.destinationPath,
    });
    throw error;
  }
}

async function copyMaterializationPath(options: {
  destinationPath: string;
  sourceKind: WorktreeIncludeSourceKind;
  sourcePath: string;
}): Promise<void> {
  if (options.sourceKind === "file") {
    await copyFile(options.sourcePath, options.destinationPath);
    return;
  }
  await cp(options.sourcePath, options.destinationPath, {
    recursive: true,
    force: true,
    dereference: false,
  });
}

async function restoreCopiedDestination(options: {
  backupPath: string;
  destinationPath: string;
}): Promise<void> {
  try {
    const destinationStats = await lstatIfExists(options.destinationPath);
    if (destinationStats !== null) {
      if (destinationStats.isSymbolicLink()) {
        throw new Error("destination changed while restoring a failed materialization");
      }
      await rm(options.destinationPath, {
        recursive: destinationStats.isDirectory(),
        force: true,
      });
    }
    await rename(options.backupPath, options.destinationPath);
  } catch (error) {
    throw new WorktreeIncludeCleanupError(
      `Unable to restore .worktreeinclude destination '${options.destinationPath}' after a failed materialization`,
      error,
    );
  }
}

async function cleanupStagingDirectory(directoryPath: string): Promise<void> {
  try {
    await rm(directoryPath, { recursive: true, force: true });
  } catch (error) {
    throw new WorktreeIncludeCleanupError(
      `Unable to clean up .worktreeinclude staging directory '${directoryPath}'`,
      error,
    );
  }
}

async function cleanupCreatedDestinationParents(createdPaths: string[]): Promise<void> {
  for (const path of createdPaths.toReversed()) {
    try {
      await rmdir(path);
    } catch (error) {
      const code = getErrorCode(error);
      if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST") {
        continue;
      }
      throw new WorktreeIncludeCleanupError(
        `Unable to clean up .worktreeinclude destination directory '${path}'`,
        error,
      );
    }
  }
}

async function readWorktreeIncludeEntries(
  sourceRoot: string,
): Promise<ParsedWorktreeIncludeEntries> {
  let contents: string;
  try {
    contents = await readFile(join(sourceRoot, WORKTREE_INCLUDE_FILE_NAME), "utf8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return { entries: [], skipped: [] };
    }
    throw error;
  }

  const entries: WorktreeIncludeEntry[] = [];
  const skipped: WorktreeIncludeSkippedEntry[] = [];

  for (const [index, sourceLine] of contents.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const line = sourceLine.trim();
    if (line.length === 0) {
      continue;
    }

    if (line.startsWith("#")) {
      continue;
    }

    try {
      entries.push(parseWorktreeIncludeEntry({ line, lineNumber }));
    } catch (error) {
      if (!isSkippableWorktreeIncludeError(error)) {
        throw error;
      }
      skipped.push(toSkippedEntry({ lineNumber, raw: line }, error));
    }
  }

  return { entries, skipped };
}

function parseWorktreeIncludeEntry(options: {
  line: string;
  lineNumber: number;
}): WorktreeIncludeEntry {
  let mode: WorktreeIncludeMode = "copy";
  let path = options.line;
  const separatorIndex = options.line.search(/\s/);

  if (separatorIndex === -1) {
    if (options.line === "copy" || options.line === "symlink") {
      throw new WorktreeIncludeError(
        "invalid_entry",
        `.worktreeinclude ${options.line} entry on line ${options.lineNumber} requires a path`,
      );
    }
  } else {
    const verb = options.line.slice(0, separatorIndex);
    if (verb === "copy" || verb === "symlink") {
      mode = verb;
      path = options.line.slice(separatorIndex).trim();
    }
  }

  return {
    lineNumber: options.lineNumber,
    mode,
    raw: options.line,
    relativePath: normalizeRelativePath({ entry: path, lineNumber: options.lineNumber }),
  };
}

function normalizeRelativePath(options: { entry: string; lineNumber: number }): string {
  const fail = (reason: string): never => {
    throw new WorktreeIncludeError(
      "invalid_entry",
      `Invalid .worktreeinclude entry '${options.entry}' on line ${options.lineNumber}: ${reason}`,
    );
  };

  if (
    options.entry.includes("\0") ||
    options.entry.startsWith("/") ||
    options.entry.startsWith("\\") ||
    isAbsolute(options.entry) ||
    win32.isAbsolute(options.entry) ||
    /^[A-Za-z]:/.test(options.entry)
  ) {
    fail("absolute paths are not allowed");
  }

  const segments = options.entry
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0) {
    fail("path must not be empty");
  }

  for (const segment of segments) {
    if (segment === "..") {
      fail("parent-directory segments are not allowed");
    }
    if (segment.toLowerCase() === ".git") {
      fail("git metadata cannot be materialized");
    }
    if (segment.includes(":") || /[. ]$/.test(segment) || isWindowsReservedSegment(segment)) {
      fail("path is not portable to Windows");
    }
  }

  return segments.join("/");
}

function isWindowsReservedSegment(segment: string): boolean {
  const basename = segment.split(".", 1)[0]?.toLowerCase() ?? "";
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(basename);
}

function getRecursiveDirectoryPath(entry: WorktreeIncludeEntry): string | null {
  const segments = entry.relativePath.split("/");
  if (
    segments.length < 2 ||
    segments.at(-1) !== "**" ||
    segments.slice(0, -1).some((segment) => segment.includes("*"))
  ) {
    return null;
  }
  return segments.slice(0, -1).join("/");
}

async function collectWorktreeIncludeCandidates(options: {
  excludedSourceRoots: string[];
  patterns: string[];
  sourceRoot: string;
}): Promise<WorktreeIncludeCandidateCollection> {
  const candidates: string[] = [];
  const errorsByPattern = new Map<string, unknown>();

  async function visit(
    directoryPath: string,
    directorySegments: string[],
    patterns: string[],
    ancestorCanonicalDirectories: ReadonlySet<string>,
  ): Promise<void> {
    let entries: Dirent<string>[];
    try {
      entries = await readdir(directoryPath, { withFileTypes: true });
    } catch (error) {
      if (getErrorCode(error) === null) {
        throw error;
      }
      for (const pattern of patterns) {
        errorsByPattern.set(pattern, error);
      }
      return;
    }
    for (const entry of entries) {
      if (entry.name.toLowerCase() === ".git") {
        continue;
      }

      const pathSegments = [...directorySegments, entry.name];
      const sourcePath = join(options.sourceRoot, ...pathSegments);
      if (
        options.excludedSourceRoots.some((excludedRoot) =>
          isPathInsideRoot(excludedRoot, sourcePath),
        )
      ) {
        continue;
      }

      const relativePath = pathSegments.join("/");
      if (patterns.some((pattern) => worktreeIncludeGlobMatches(pattern, relativePath))) {
        candidates.push(relativePath);
      }
      const descendantPatterns = patterns.filter((pattern) =>
        canGlobMatchDescendant(pattern, pathSegments),
      );
      if ((entry.isDirectory() || entry.isSymbolicLink()) && descendantPatterns.length > 0) {
        try {
          const canonicalDirectory = await realpath(sourcePath);
          const canonicalStats = await lstat(canonicalDirectory);
          const canonicalRelativePath = relative(options.sourceRoot, canonicalDirectory);
          const isGitMetadata = canonicalRelativePath
            .split(/[\\/]/)
            .some((segment) => segment.toLowerCase() === ".git");
          const overlapsProtectedRoot = options.excludedSourceRoots.some(
            (excludedRoot) =>
              isPathInsideRoot(excludedRoot, canonicalDirectory) ||
              isPathInsideRoot(canonicalDirectory, excludedRoot),
          );
          if (
            !canonicalStats.isDirectory() ||
            !isPathInsideRoot(options.sourceRoot, canonicalDirectory) ||
            isGitMetadata ||
            overlapsProtectedRoot ||
            ancestorCanonicalDirectories.has(canonicalDirectory)
          ) {
            continue;
          }
          await visit(
            sourcePath,
            pathSegments,
            descendantPatterns,
            new Set([...ancestorCanonicalDirectories, canonicalDirectory]),
          );
        } catch (error) {
          if (getErrorCode(error) === null) {
            throw error;
          }
          for (const pattern of descendantPatterns) {
            errorsByPattern.set(pattern, error);
          }
        }
      }
    }
  }

  await visit(
    options.sourceRoot,
    [],
    options.patterns,
    new Set([await realpath(options.sourceRoot)]),
  );
  return { candidates: candidates.sort(), errorsByPattern };
}

function canGlobMatchDescendant(pattern: string, directorySegments: string[]): boolean {
  const patternSegments = pattern.split("/");
  const cache = new Map<string, boolean>();

  function match(patternIndex: number, directoryIndex: number): boolean {
    const cacheKey = `${patternIndex}:${directoryIndex}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const patternSegment = patternSegments[patternIndex];
    let result: boolean;
    if (directoryIndex === directorySegments.length) {
      result = patternSegment !== undefined;
    } else if (patternSegment === "**") {
      result = match(patternIndex + 1, directoryIndex) || match(patternIndex, directoryIndex + 1);
    } else {
      const directorySegment = directorySegments[directoryIndex];
      result =
        patternSegment !== undefined &&
        segmentGlobMatches(patternSegment, directorySegment) &&
        match(patternIndex + 1, directoryIndex + 1);
    }

    cache.set(cacheKey, result);
    return result;
  }

  return match(0, 0);
}

function resolveEntryMatches(options: {
  candidates: string[];
  entry: WorktreeIncludeEntry;
}): string[] {
  if (!options.entry.relativePath.includes("*")) {
    return [options.entry.relativePath];
  }

  const recursiveDirectoryPath = getRecursiveDirectoryPath(options.entry);
  if (recursiveDirectoryPath !== null) {
    return [recursiveDirectoryPath];
  }

  return options.candidates.filter((candidate) =>
    worktreeIncludeGlobMatches(options.entry.relativePath, candidate),
  );
}

function worktreeIncludeGlobMatches(pattern: string, candidate: string): boolean {
  const patternSegments = pattern.split("/");
  const candidateSegments = candidate.split("/");
  const cache = new Map<string, boolean>();

  function match(patternIndex: number, candidateIndex: number): boolean {
    const cacheKey = `${patternIndex}:${candidateIndex}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const patternSegment = patternSegments[patternIndex];
    let result: boolean;
    if (patternSegment === undefined) {
      result = candidateIndex === candidateSegments.length;
    } else if (patternSegment === "**") {
      result =
        match(patternIndex + 1, candidateIndex) ||
        (candidateIndex < candidateSegments.length && match(patternIndex, candidateIndex + 1));
    } else {
      const candidateSegment = candidateSegments[candidateIndex];
      result =
        candidateSegment !== undefined &&
        segmentGlobMatches(patternSegment, candidateSegment) &&
        match(patternIndex + 1, candidateIndex + 1);
    }

    cache.set(cacheKey, result);
    return result;
  }

  return match(0, 0);
}

function segmentGlobMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`).test(value);
}

async function resolveSourceMaterialization(options: {
  entry: WorktreeIncludeEntry;
  excludedSourceRoots: string[];
  relativePath: string;
  sourceRoot: string;
}): Promise<ResolvedWorktreeIncludeMaterialization> {
  const requestedSourcePath = join(options.sourceRoot, ...options.relativePath.split("/"));
  const sourcePath = await realpathSourcePath(requestedSourcePath, options.entry);
  assertSourcePathIsSafe({
    entry: options.entry,
    excludedSourceRoots: options.excludedSourceRoots,
    sourcePath,
    sourceRoot: options.sourceRoot,
  });

  const sourceKind = await getCanonicalSourceKind({
    entry: options.entry,
    sourcePath,
  });
  if (
    getRecursiveDirectoryPath(options.entry) === options.relativePath &&
    sourceKind !== "directory"
  ) {
    throw new WorktreeIncludeError(
      "unsupported_source",
      `.worktreeinclude entry '${options.entry.raw}' on line ${options.entry.lineNumber} requires a directory`,
    );
  }
  if (sourceKind === "directory") {
    if (options.entry.mode === "copy") {
      await assertCopyDirectorySafe({
        entry: options.entry,
        sourcePath,
      });
    } else {
      await assertSymlinkDirectorySafe({
        entry: options.entry,
        excludedSourceRoots: options.excludedSourceRoots,
        sourcePath,
        sourceRoot: options.sourceRoot,
      });
    }
  }

  return {
    materialization: {
      lineNumber: options.entry.lineNumber,
      mode: options.entry.mode,
      raw: options.entry.raw,
      relativePath: options.relativePath,
      sourceKind,
    },
    sourcePath,
  };
}

function assertSourcePathIsSafe(options: {
  entry: WorktreeIncludeEntry;
  excludedSourceRoots: string[];
  sourcePath: string;
  sourceRoot: string;
}): void {
  if (!isPathInsideRoot(options.sourceRoot, options.sourcePath)) {
    throw new WorktreeIncludeError(
      "unsupported_source",
      `.worktreeinclude entry '${options.entry.raw}' on line ${options.entry.lineNumber} resolves outside the source checkout`,
    );
  }

  const canonicalRelativePath = relative(options.sourceRoot, options.sourcePath);
  if (canonicalRelativePath.split(/[\\/]/).some((segment) => segment.toLowerCase() === ".git")) {
    throw new WorktreeIncludeError(
      "unsupported_source",
      `.worktreeinclude entry '${options.entry.raw}' on line ${options.entry.lineNumber} resolves into Git metadata`,
    );
  }

  const excludedRoot = options.excludedSourceRoots.find(
    (candidate) =>
      isPathInsideRoot(options.sourcePath, candidate) ||
      isPathInsideRoot(candidate, options.sourcePath),
  );
  if (excludedRoot === undefined) {
    return;
  }

  throw new WorktreeIncludeError(
    "unsupported_source",
    `.worktreeinclude entry '${options.entry.raw}' on line ${options.entry.lineNumber} overlaps with a protected worktree path`,
  );
}

async function getCanonicalSourceKind(options: {
  entry: WorktreeIncludeEntry;
  sourcePath: string;
}): Promise<WorktreeIncludeSourceKind> {
  const stats = await lstatSourcePath(options.sourcePath, options.entry);
  if (stats.isSymbolicLink()) {
    throw new WorktreeIncludeError(
      "unsupported_source",
      `.worktreeinclude entry '${options.entry.raw}' on line ${options.entry.lineNumber} changed while its source path was resolved`,
    );
  }
  if (!stats.isFile() && !stats.isDirectory()) {
    throw new WorktreeIncludeError(
      "unsupported_source",
      `.worktreeinclude entry '${options.entry.raw}' on line ${options.entry.lineNumber} must match a regular file or directory`,
    );
  }

  return stats.isDirectory() ? "directory" : "file";
}

async function realpathSourcePath(
  sourcePath: string,
  entry: WorktreeIncludeEntry,
): Promise<string> {
  try {
    return await realpath(sourcePath);
  } catch (error) {
    const code = getErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw noMatchError(entry);
    }
    if (code === "ELOOP") {
      throw new WorktreeIncludeError(
        "unsupported_source",
        `.worktreeinclude entry '${entry.raw}' on line ${entry.lineNumber} contains a symbolic-link loop`,
      );
    }
    throw error;
  }
}

async function lstatSourcePath(sourcePath: string, entry: WorktreeIncludeEntry): Promise<Stats> {
  try {
    return await lstat(sourcePath);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT" || getErrorCode(error) === "ENOTDIR") {
      throw noMatchError(entry);
    }
    throw error;
  }
}

async function assertCopyDirectorySafe(options: {
  entry: WorktreeIncludeEntry;
  sourcePath: string;
}): Promise<void> {
  for (const name of await readdir(options.sourcePath)) {
    if (name.toLowerCase() === ".git") {
      throw new WorktreeIncludeError(
        "unsupported_source",
        `.worktreeinclude entry '${options.entry.raw}' on line ${options.entry.lineNumber} contains git metadata`,
      );
    }

    const sourcePath = join(options.sourcePath, name);
    const stats = await lstatSourcePath(sourcePath, options.entry);
    if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) {
      throw new WorktreeIncludeError(
        "unsupported_source",
        `.worktreeinclude entry '${options.entry.raw}' on line ${options.entry.lineNumber} contains an unsupported file type or symbolic link`,
      );
    }
    if (stats.isDirectory()) {
      await assertCopyDirectorySafe({ sourcePath, entry: options.entry });
    }
  }
}

async function assertSymlinkDirectorySafe(options: {
  entry: WorktreeIncludeEntry;
  excludedSourceRoots: string[];
  sourcePath: string;
  sourceRoot: string;
}): Promise<void> {
  const visitedDirectories = new Set<string>();

  async function visit(directoryPath: string): Promise<void> {
    if (visitedDirectories.has(directoryPath)) {
      return;
    }
    visitedDirectories.add(directoryPath);

    for (const name of await readdir(directoryPath)) {
      if (name.toLowerCase() === ".git") {
        throw new WorktreeIncludeError(
          "unsupported_source",
          `.worktreeinclude entry '${options.entry.raw}' on line ${options.entry.lineNumber} contains git metadata`,
        );
      }

      const childPath = join(directoryPath, name);
      const childStats = await lstatSourcePath(childPath, options.entry);
      if (childStats.isSymbolicLink()) {
        const linkedPath = await realpathSourcePath(childPath, options.entry);
        assertSourcePathIsSafe({
          entry: options.entry,
          excludedSourceRoots: options.excludedSourceRoots,
          sourcePath: linkedPath,
          sourceRoot: options.sourceRoot,
        });
        const linkedKind = await getCanonicalSourceKind({
          entry: options.entry,
          sourcePath: linkedPath,
        });
        if (linkedKind === "directory") {
          await visit(linkedPath);
        }
        continue;
      }

      if (childStats.isDirectory()) {
        await visit(childPath);
        continue;
      }
      if (!childStats.isFile()) {
        throw new WorktreeIncludeError(
          "unsupported_source",
          `.worktreeinclude entry '${options.entry.raw}' on line ${options.entry.lineNumber} contains an unsupported file type`,
        );
      }
    }
  }

  await visit(options.sourcePath);
}

function normalizeMaterializations(
  materializations: WorktreeIncludeMaterialization[],
): NormalizedWorktreeIncludeMaterializations {
  const byPath = new Map<string, WorktreeIncludeMaterialization[]>();
  for (const materialization of materializations) {
    const matches = byPath.get(materialization.relativePath) ?? [];
    matches.push(materialization);
    byPath.set(materialization.relativePath, matches);
  }

  const skipped: WorktreeIncludeSkippedEntry[] = [];
  const candidates: WorktreeIncludeMaterialization[] = [];
  for (const [relativePath, matches] of byPath) {
    if (new Set(matches.map((materialization) => materialization.mode)).size === 1) {
      candidates.push(matches[0]!);
      continue;
    }

    const message = `.worktreeinclude entries for '${relativePath}' use both copy and symlink modes`;
    skipped.push(
      ...matches.map((materialization) =>
        toSkippedEntry(materialization, new WorktreeIncludeError("conflict", message)),
      ),
    );
  }

  const conflicted = new Set<WorktreeIncludeMaterialization>();
  const skippedConflictEntries = new Set<WorktreeIncludeMaterialization>();
  const skipConflict = (materialization: WorktreeIncludeMaterialization, message: string): void => {
    conflicted.add(materialization);
    if (skippedConflictEntries.has(materialization)) {
      return;
    }
    skippedConflictEntries.add(materialization);
    skipped.push(toSkippedEntry(materialization, new WorktreeIncludeError("conflict", message)));
  };

  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex++) {
    const left = candidates[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex++) {
      const right = candidates[rightIndex]!;
      let ancestor: WorktreeIncludeMaterialization | null = null;
      if (isRelativePathAncestor(left.relativePath, right.relativePath)) {
        ancestor = left;
      } else if (isRelativePathAncestor(right.relativePath, left.relativePath)) {
        ancestor = right;
      }
      if (ancestor === null || (left.mode === "copy" && right.mode === "copy")) {
        continue;
      }

      const descendant = ancestor === left ? right : left;
      const message = `.worktreeinclude entries for '${ancestor.relativePath}' and '${descendant.relativePath}' overlap with a symlink`;
      skipConflict(left, message);
      skipConflict(right, message);
    }
  }

  const sorted = candidates
    .filter((materialization) => !conflicted.has(materialization))
    .sort((left, right) => {
      const depthDifference =
        left.relativePath.split("/").length - right.relativePath.split("/").length;
      return depthDifference === 0
        ? left.relativePath.localeCompare(right.relativePath)
        : depthDifference;
    });
  return { materializations: sorted, skipped };
}

function isRelativePathAncestor(ancestor: string, candidate: string): boolean {
  return ancestor !== candidate && candidate.startsWith(`${ancestor}/`);
}

async function preflightDestination(options: {
  resolved: ResolvedWorktreeIncludeMaterialization;
  worktreeRoot: string;
}): Promise<boolean> {
  const { materialization } = options.resolved;
  const destinationPath = getDestinationPath({
    worktreeRoot: options.worktreeRoot,
    relativePath: materialization.relativePath,
  });
  const destinationStats = await lstatIfExists(destinationPath);
  if (destinationStats === null) {
    return true;
  }

  if (destinationStats.isSymbolicLink()) {
    if (
      materialization.mode === "symlink" &&
      (await isExpectedSymlink({
        destinationPath,
        sourcePath: options.resolved.sourcePath,
      }))
    ) {
      return false;
    }
    throw destinationConflict(materialization);
  }

  if (materialization.mode === "symlink") {
    throw destinationConflict(materialization);
  }

  if (
    (materialization.sourceKind === "file" && !destinationStats.isFile()) ||
    (materialization.sourceKind === "directory" && !destinationStats.isDirectory())
  ) {
    throw destinationConflict(materialization);
  }

  if (materialization.sourceKind === "directory") {
    await assertCopyDestinationTreeSafe({
      sourcePath: options.resolved.sourcePath,
      destinationPath,
      materialization,
    });
  }
  return true;
}

function getDestinationPath(options: { relativePath: string; worktreeRoot: string }): string {
  const destinationPath = join(options.worktreeRoot, ...options.relativePath.split("/"));
  if (!isPathInsideRoot(options.worktreeRoot, destinationPath)) {
    throw new WorktreeIncludeError(
      "invalid_entry",
      `.worktreeinclude entry '${options.relativePath}' resolves outside the worktree`,
    );
  }
  return destinationPath;
}

async function ensureDestinationParent(options: {
  relativePath: string;
  worktreeRoot: string;
}): Promise<string[]> {
  const parentSegments = options.relativePath.split("/").slice(0, -1);
  let currentPath = options.worktreeRoot;
  const createdPaths: string[] = [];
  try {
    for (const segment of parentSegments) {
      currentPath = join(currentPath, segment);
      const stats = await lstatIfExists(currentPath);
      if (stats === null) {
        await mkdir(currentPath);
        createdPaths.push(currentPath);
        continue;
      }
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new WorktreeIncludeError(
          "conflict",
          `Refusing to materialize .worktreeinclude entry '${options.relativePath}' through '${currentPath}'`,
        );
      }
    }
  } catch (error) {
    await cleanupCreatedDestinationParents(createdPaths);
    throw error;
  }
  return createdPaths;
}

async function assertCopyDestinationTreeSafe(options: {
  destinationPath: string;
  materialization: WorktreeIncludeMaterialization;
  sourcePath: string;
}): Promise<void> {
  for (const name of await readdir(options.sourcePath)) {
    const sourceChildPath = join(options.sourcePath, name);
    const sourceStats = await lstat(sourceChildPath);
    if (sourceStats.isSymbolicLink()) {
      throw new WorktreeIncludeError(
        "unsupported_source",
        `.worktreeinclude entry '${options.materialization.relativePath}' contains a symbolic link`,
      );
    }

    const destinationChildPath = join(options.destinationPath, name);
    const destinationStats = await lstatIfExists(destinationChildPath);
    if (destinationStats === null) {
      continue;
    }
    if (destinationStats.isSymbolicLink()) {
      throw destinationConflict(options.materialization);
    }
    if (
      (sourceStats.isFile() && !destinationStats.isFile()) ||
      (sourceStats.isDirectory() && !destinationStats.isDirectory())
    ) {
      throw destinationConflict(options.materialization);
    }
    if (sourceStats.isDirectory()) {
      await assertCopyDestinationTreeSafe({
        sourcePath: sourceChildPath,
        destinationPath: destinationChildPath,
        materialization: options.materialization,
      });
    }
  }
}

async function createMaterializationSymlink(options: {
  destinationPath: string;
  linkDestinationPath?: string;
  resolved: ResolvedWorktreeIncludeMaterialization;
}): Promise<void> {
  if (process.platform !== "win32") {
    const target = relative(
      dirname(options.linkDestinationPath ?? options.destinationPath),
      options.resolved.sourcePath,
    );
    await symlink(target, options.destinationPath);
    return;
  }

  let type: "dir" | "file" | "junction" = "file";
  if (options.resolved.materialization.sourceKind === "directory") {
    type = isWindowsNetworkPath(options.resolved.sourcePath) ? "dir" : "junction";
  }
  try {
    await symlink(options.resolved.sourcePath, options.destinationPath, type);
  } catch (error) {
    throw toWindowsSymlinkError({ error, entry: options.resolved.materialization });
  }
}

function isWindowsSymlinkPrivilegeError(error: unknown): boolean {
  const code = getErrorCode(error);
  return code === "EACCES" || code === "EPERM" || code === "ENOTSUP";
}

function isWindowsNetworkPath(path: string): boolean {
  return path.startsWith("\\\\");
}

function toWindowsSymlinkError(options: {
  entry: WorktreeIncludeMaterialization;
  error: unknown;
}): Error {
  if (!isWindowsSymlinkPrivilegeError(options.error)) {
    return options.error instanceof Error ? options.error : new Error(String(options.error));
  }
  return new WorktreeIncludeError(
    "windows_symlink_unavailable",
    `Unable to create a Windows symlink for .worktreeinclude entry '${options.entry.relativePath}'. Enable Developer Mode or use copy ${options.entry.relativePath}.`,
  );
}

async function isExpectedSymlink(options: {
  destinationPath: string;
  sourcePath: string;
}): Promise<boolean> {
  try {
    const [destinationTarget, sourceTarget] = await Promise.all([
      realpath(options.destinationPath),
      realpath(options.sourcePath),
    ]);
    return areEquivalentPaths(destinationTarget, sourceTarget);
  } catch {
    return false;
  }
}

async function lstatIfExists(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function destinationConflict(
  materialization: WorktreeIncludeMaterialization,
): WorktreeIncludeError {
  return new WorktreeIncludeError(
    "conflict",
    `.worktreeinclude entry '${materialization.relativePath}' on line ${materialization.lineNumber} conflicts with the new worktree`,
  );
}

function noMatchError(entry: WorktreeIncludeEntry): WorktreeIncludeError {
  return new WorktreeIncludeError(
    "missing_source",
    `No paths matched .worktreeinclude entry '${entry.raw}' on line ${entry.lineNumber}`,
  );
}

function toSkippedEntry(
  entry: Pick<WorktreeIncludeEntry, "lineNumber" | "raw">,
  error: unknown,
): WorktreeIncludeSkippedEntry {
  return {
    lineNumber: entry.lineNumber,
    message: error instanceof Error ? error.message : String(error),
    raw: entry.raw,
    reason: getSkipReason(error),
  };
}

function getSkipReason(error: unknown): WorktreeIncludeSkipReason {
  if (!(error instanceof WorktreeIncludeError)) {
    return "materialization";
  }
  switch (error.code) {
    case "conflict":
      return "conflict";
    case "invalid_entry":
      return "invalid";
    case "windows_symlink_unavailable":
      return "materialization";
    case "missing_source":
      return "missing";
    case "source_changed":
      return "source_changed";
    case "unsupported_source":
      return "unsafe";
  }
}

function isSkippableWorktreeIncludeError(error: unknown): error is WorktreeIncludeError {
  return error instanceof WorktreeIncludeError && error.code !== "windows_symlink_unavailable";
}

function isWorktreeIncludeMaterializationError(error: unknown): boolean {
  return error instanceof WorktreeIncludeError || getErrorCode(error) !== null;
}

function getErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  const { code } = error;
  return typeof code === "string" ? code : null;
}
