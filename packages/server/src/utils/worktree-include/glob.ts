import { type Dirent } from "fs";
import { lstat, readdir, realpath } from "fs/promises";
import { join, relative } from "path";
import { getErrorCode } from "./errors.js";
import { getRecursiveDirectoryPath } from "./parse.js";
import { isPathInsideRoot } from "../path.js";
import type { WorktreeIncludeCandidateCollection, WorktreeIncludeEntry } from "./types.js";

export async function collectWorktreeIncludeCandidates(options: {
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

export function resolveEntryMatches(options: {
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

export function worktreeIncludeGlobMatches(pattern: string, candidate: string): boolean {
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

function segmentGlobMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`).test(value);
}
