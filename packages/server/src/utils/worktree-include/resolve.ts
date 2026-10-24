import { lstat, readdir, realpath } from "fs/promises";
import { join, relative } from "path";
import { getErrorCode, noMatchError, toSkippedEntry, WorktreeIncludeError } from "./errors.js";
import { getRecursiveDirectoryPath } from "./parse.js";
import { isPathInsideRoot } from "../path.js";
import type {
  NormalizedWorktreeIncludeMaterializations,
  ResolvedWorktreeIncludeMaterialization,
  WorktreeIncludeEntry,
  WorktreeIncludeMaterialization,
} from "./types.js";

export async function resolveSourceMaterialization(options: {
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

export function assertSourcePathIsSafe(options: {
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
}): Promise<"file" | "directory"> {
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

async function lstatSourcePath(sourcePath: string, entry: WorktreeIncludeEntry) {
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

export function normalizeMaterializations(
  materializations: WorktreeIncludeMaterialization[],
): NormalizedWorktreeIncludeMaterializations {
  const byPath = new Map<string, WorktreeIncludeMaterialization[]>();
  for (const materialization of materializations) {
    const matches = byPath.get(materialization.relativePath) ?? [];
    matches.push(materialization);
    byPath.set(materialization.relativePath, matches);
  }

  const skipped: NormalizedWorktreeIncludeMaterializations["skipped"] = [];
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
