import { type Stats } from "fs";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
} from "fs/promises";
import { dirname, join, relative } from "path";
import { areEquivalentPaths, isPathInsideRoot } from "../path.js";
import {
  destinationConflict,
  getErrorCode,
  WorktreeIncludeCleanupError,
  WorktreeIncludeError,
} from "./errors.js";
import type {
  ResolvedWorktreeIncludeMaterialization,
  StagedWorktreeIncludeMaterialization,
  WorktreeIncludeMaterialization,
} from "./types.js";

export async function stageMaterialization(options: {
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

export async function copyStagedMaterializationToExistingDestination(options: {
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
  sourceKind: "file" | "directory";
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

export async function cleanupStagingDirectory(directoryPath: string): Promise<void> {
  try {
    await rm(directoryPath, { recursive: true, force: true });
  } catch (error) {
    throw new WorktreeIncludeCleanupError(
      `Unable to clean up .worktreeinclude staging directory '${directoryPath}'`,
      error,
    );
  }
}

export async function cleanupCreatedDestinationParents(createdPaths: string[]): Promise<void> {
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

export async function preflightDestination(options: {
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

export function getDestinationPath(options: {
  relativePath: string;
  worktreeRoot: string;
}): string {
  const destinationPath = join(options.worktreeRoot, ...options.relativePath.split("/"));
  if (!isPathInsideRoot(options.worktreeRoot, destinationPath)) {
    throw new WorktreeIncludeError(
      "invalid_entry",
      `.worktreeinclude entry '${options.relativePath}' resolves outside the worktree`,
    );
  }
  return destinationPath;
}

export async function ensureDestinationParent(options: {
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

async function assertCopyDirectorySafe(options: {
  entry: WorktreeIncludeMaterialization;
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
    const stats = await lstat(sourcePath);
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
