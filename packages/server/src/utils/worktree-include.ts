import { type Stats } from "fs";
import { copyFile, cp, lstat, mkdir, readFile, readdir, realpath, symlink } from "fs/promises";
import {
  basename as pathBasename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
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

interface WorktreeIncludeEntry {
  lineNumber: number;
  mode: WorktreeIncludeMode;
  raw: string;
  relativePath: string;
}

export interface WorktreeIncludeMaterialization {
  lineNumber: number;
  mode: WorktreeIncludeMode;
  relativePath: string;
  sourceKind: WorktreeIncludeSourceKind;
}

export interface WorktreeIncludePlan {
  materializations: WorktreeIncludeMaterialization[];
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

export class WorktreeIncludeError extends Error {
  constructor(
    public readonly code: WorktreeIncludeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorktreeIncludeError";
  }
}

export async function readWorktreeIncludePlan(
  options: ReadWorktreeIncludePlanOptions,
): Promise<WorktreeIncludePlan> {
  const sourceRoot = await realpath(options.sourceRoot);
  const entries = await readWorktreeIncludeEntries(sourceRoot);
  if (entries.length === 0) {
    return { sourceRoot, materializations: [] };
  }

  const excludedSourceRoots = await Promise.all(
    (options.excludedSourceRoots ?? []).map(canonicalizeExistingPathPrefix),
  );
  const candidatePatterns = entries
    .filter(
      (entry) => entry.relativePath.includes("*") && getRecursiveDirectoryPath(entry) === null,
    )
    .map((entry) => entry.relativePath);
  const candidates =
    candidatePatterns.length > 0
      ? await collectWorktreeIncludeCandidates({
          sourceRoot,
          excludedSourceRoots,
          patterns: candidatePatterns,
        })
      : [];
  const materializations: WorktreeIncludeMaterialization[] = [];

  for (const entry of entries) {
    const matchedPaths = resolveEntryMatches({ entry, candidates });
    if (matchedPaths.length === 0) {
      throw noMatchError(entry);
    }

    for (const relativePath of matchedPaths) {
      assertSourcePathDoesNotOverlapExcludedRoot({
        entry,
        excludedSourceRoots,
        sourcePath: join(sourceRoot, ...relativePath.split("/")),
      });
      const resolved = await resolveSourceMaterialization({
        sourceRoot,
        entry,
        relativePath,
      });
      materializations.push(resolved.materialization);
    }
  }

  return {
    sourceRoot,
    materializations: normalizeMaterializations(materializations),
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
): Promise<void> {
  if (options.plan.materializations.length === 0) {
    return;
  }

  const worktreeRoot = await realpath(options.worktreeRoot);
  for (const materialization of options.plan.materializations) {
    const resolved = await resolveSourceMaterialization({
      sourceRoot: options.plan.sourceRoot,
      entry: {
        lineNumber: materialization.lineNumber,
        mode: materialization.mode,
        raw: materialization.relativePath,
        relativePath: materialization.relativePath,
      },
      relativePath: materialization.relativePath,
    });
    if (resolved.materialization.sourceKind !== materialization.sourceKind) {
      throw new WorktreeIncludeError(
        "source_changed",
        `Source for .worktreeinclude entry '${materialization.relativePath}' changed type before it could be materialized`,
      );
    }
    const destinationPath = getDestinationPath({
      worktreeRoot,
      relativePath: resolved.materialization.relativePath,
    });
    await ensureDestinationParent({
      worktreeRoot,
      relativePath: resolved.materialization.relativePath,
    });
    const needsMaterialization = await preflightDestination({
      worktreeRoot,
      resolved,
    });
    if (!needsMaterialization) {
      continue;
    }

    if (resolved.materialization.mode === "copy") {
      if (resolved.materialization.sourceKind === "file") {
        await copyFile(resolved.sourcePath, destinationPath);
      } else {
        await cp(resolved.sourcePath, destinationPath, {
          recursive: true,
          force: true,
          dereference: false,
        });
      }
      continue;
    }

    await createMaterializationSymlink({
      destinationPath,
      resolved,
    });
  }
}

async function readWorktreeIncludeEntries(sourceRoot: string): Promise<WorktreeIncludeEntry[]> {
  let contents: string;
  try {
    contents = await readFile(join(sourceRoot, WORKTREE_INCLUDE_FILE_NAME), "utf8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return [];
    }
    throw error;
  }

  const entries: WorktreeIncludeEntry[] = [];

  for (const [index, sourceLine] of contents.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const line = sourceLine.trim();
    if (line.length === 0) {
      continue;
    }

    if (line.startsWith("#")) {
      continue;
    }

    entries.push(parseWorktreeIncludeEntry({ line, lineNumber }));
  }

  return entries;
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
}): Promise<string[]> {
  const candidates: string[] = [];

  async function visit(directoryPath: string, directorySegments: string[]): Promise<void> {
    const entries = await readdir(directoryPath, { withFileTypes: true });
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
      if (options.patterns.some((pattern) => worktreeIncludeGlobMatches(pattern, relativePath))) {
        candidates.push(relativePath);
      }
      if (
        entry.isDirectory() &&
        options.patterns.some((pattern) => canGlobMatchDescendant(pattern, pathSegments))
      ) {
        await visit(sourcePath, pathSegments);
      }
    }
  }

  await visit(options.sourceRoot, []);
  return candidates.sort();
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
  relativePath: string;
  sourceRoot: string;
}): Promise<ResolvedWorktreeIncludeMaterialization> {
  const sourcePath = join(options.sourceRoot, ...options.relativePath.split("/"));
  const sourceKind = await getSourceKind({
    sourceRoot: options.sourceRoot,
    sourcePath,
    entry: options.entry,
  });
  if (options.entry.mode === "copy" && sourceKind === "directory") {
    await assertCopyDirectorySafe({
      sourcePath,
      entry: options.entry,
    });
  }

  return {
    materialization: {
      lineNumber: options.entry.lineNumber,
      mode: options.entry.mode,
      relativePath: options.relativePath,
      sourceKind,
    },
    sourcePath,
  };
}

function assertSourcePathDoesNotOverlapExcludedRoot(options: {
  entry: WorktreeIncludeEntry;
  excludedSourceRoots: string[];
  sourcePath: string;
}): void {
  const excludedRoot = options.excludedSourceRoots.find(
    (candidate) =>
      isPathInsideRoot(options.sourcePath, candidate) ||
      isPathInsideRoot(candidate, options.sourcePath),
  );
  if (excludedRoot === undefined) {
    return;
  }

  throw new WorktreeIncludeError(
    "invalid_entry",
    `.worktreeinclude entry '${options.entry.raw}' on line ${options.entry.lineNumber} overlaps with a protected worktree path`,
  );
}

async function getSourceKind(options: {
  entry: WorktreeIncludeEntry;
  sourcePath: string;
  sourceRoot: string;
}): Promise<WorktreeIncludeSourceKind> {
  const segments = relative(options.sourceRoot, options.sourcePath).split(sep).filter(Boolean);
  let currentPath = options.sourceRoot;
  for (const segment of segments.slice(0, -1)) {
    currentPath = join(currentPath, segment);
    const currentStats = await lstatSourcePath(currentPath, options.entry);
    if (currentStats.isSymbolicLink()) {
      throw new WorktreeIncludeError(
        "unsupported_source",
        `.worktreeinclude entry '${options.entry.raw}' on line ${options.entry.lineNumber} resolves through a symbolic link`,
      );
    }
  }

  const stats = await lstatSourcePath(options.sourcePath, options.entry);
  if (stats.isSymbolicLink()) {
    throw new WorktreeIncludeError(
      "unsupported_source",
      `.worktreeinclude entry '${options.entry.raw}' on line ${options.entry.lineNumber} resolves through a symbolic link`,
    );
  }
  if (!stats.isFile() && !stats.isDirectory()) {
    throw new WorktreeIncludeError(
      "unsupported_source",
      `.worktreeinclude entry '${options.entry.raw}' on line ${options.entry.lineNumber} must match a regular file or directory`,
    );
  }

  const canonicalSourcePath = await realpath(options.sourcePath);
  if (!isPathInsideRoot(options.sourceRoot, canonicalSourcePath)) {
    throw new WorktreeIncludeError(
      "unsupported_source",
      `.worktreeinclude entry '${options.entry.raw}' on line ${options.entry.lineNumber} resolves outside the source checkout`,
    );
  }

  return stats.isDirectory() ? "directory" : "file";
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

function normalizeMaterializations(
  materializations: WorktreeIncludeMaterialization[],
): WorktreeIncludeMaterialization[] {
  const byPath = new Map<string, WorktreeIncludeMaterialization>();
  for (const materialization of materializations) {
    const existing = byPath.get(materialization.relativePath);
    if (existing === undefined) {
      byPath.set(materialization.relativePath, materialization);
      continue;
    }
    if (existing.mode !== materialization.mode) {
      throw new WorktreeIncludeError(
        "conflict",
        `.worktreeinclude entries for '${materialization.relativePath}' use both copy and symlink modes`,
      );
    }
  }

  const sorted = [...byPath.values()].sort((left, right) => {
    const depthDifference =
      left.relativePath.split("/").length - right.relativePath.split("/").length;
    return depthDifference === 0
      ? left.relativePath.localeCompare(right.relativePath)
      : depthDifference;
  });
  const normalized: WorktreeIncludeMaterialization[] = [];

  for (const materialization of sorted) {
    const ancestor = normalized.find((candidate) =>
      isRelativePathAncestor(candidate.relativePath, materialization.relativePath),
    );
    if (ancestor === undefined) {
      normalized.push(materialization);
      continue;
    }
    if (ancestor.mode === "copy" && materialization.mode === "copy") {
      continue;
    }
    throw new WorktreeIncludeError(
      "conflict",
      `.worktreeinclude entries for '${ancestor.relativePath}' and '${materialization.relativePath}' overlap with a symlink`,
    );
  }

  return normalized;
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
}): Promise<void> {
  const parentSegments = options.relativePath.split("/").slice(0, -1);
  let currentPath = options.worktreeRoot;
  for (const segment of parentSegments) {
    currentPath = join(currentPath, segment);
    const stats = await lstatIfExists(currentPath);
    if (stats === null) {
      await mkdir(currentPath);
      continue;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new WorktreeIncludeError(
        "conflict",
        `Refusing to materialize .worktreeinclude entry '${options.relativePath}' through '${currentPath}'`,
      );
    }
  }
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
  resolved: ResolvedWorktreeIncludeMaterialization;
}): Promise<void> {
  if (process.platform !== "win32") {
    const target = relative(dirname(options.destinationPath), options.resolved.sourcePath);
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

function getErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  const { code } = error;
  return typeof code === "string" ? code : null;
}
