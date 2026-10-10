import { type Stats } from "fs";
import { lstat, realpath, rename } from "fs/promises";
import { basename as pathBasename, dirname, join, resolve } from "path";
import {
  getErrorCode,
  isSkippableWorktreeIncludeError,
  isWorktreeIncludeMaterializationError,
  noMatchError,
  toSkippedEntry,
  WorktreeIncludeCleanupError,
  WorktreeIncludeError,
} from "./errors.js";
import { collectWorktreeIncludeCandidates, resolveEntryMatches } from "./glob.js";
import {
  cleanupCreatedDestinationParents,
  cleanupStagingDirectory,
  copyStagedMaterializationToExistingDestination,
  ensureDestinationParent,
  getDestinationPath,
  preflightDestination,
  stageMaterialization,
} from "./materialize.js";
import { getRecursiveDirectoryPath, readWorktreeIncludeEntries } from "./parse.js";
import { normalizeMaterializations, resolveSourceMaterialization } from "./resolve.js";
import { isPathInsideRoot } from "../path.js";
import type {
  MaterializeWorktreeIncludePlanOptions,
  ReadWorktreeIncludePlanOptions,
  WorktreeIncludePlan,
  WorktreeIncludeMaterialization,
  WorktreeIncludeSkippedEntry,
  WorktreeIncludeSummary,
  ResolvedWorktreeIncludeMaterialization,
} from "./types.js";

export { WorktreeIncludeError };
export type {
  MaterializeWorktreeIncludePlanOptions,
  ReadWorktreeIncludePlanOptions,
  WorktreeIncludeEntry,
  WorktreeIncludeErrorCode,
  WorktreeIncludeMaterialization,
  WorktreeIncludeMode,
  WorktreeIncludePlan,
  WorktreeIncludeSkipReason,
  WorktreeIncludeSkippedEntry,
  WorktreeIncludeSourceKind,
  WorktreeIncludeSummary,
} from "./types.js";

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
        if (!isSkippableWorktreeIncludeError(error) && getErrorCode(error) === null) {
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

    let staged: Awaited<ReturnType<typeof stageMaterialization>> | null = null;
    let createdDestinationParents: string[] = [];
    try {
      const destinationPath = getDestinationPath({
        worktreeRoot,
        relativePath: resolved.materialization.relativePath,
      });
      if (!(await preflightDestination({ worktreeRoot, resolved }))) {
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
      if (!(await preflightDestination({ worktreeRoot, resolved }))) {
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
