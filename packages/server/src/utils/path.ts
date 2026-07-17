import os from "node:os";
import { realpathSync } from "node:fs";
import nodePath from "node:path";

/**
 * Expand tilde in path to home directory
 */
export function expandTilde(path: string): string {
  if (path.startsWith("~/")) {
    const homeDir = process.env.HOME || os.homedir();
    return path.replace("~", homeDir);
  }
  if (path === "~") {
    return process.env.HOME || os.homedir();
  }
  return path;
}

/**
 * Compare two path strings as filesystem-equivalent for cwd filtering.
 *
 * This is a string-only comparison: it normalizes separators and dot segments,
 * ignores trailing separators, strips Windows namespace prefixes, and
 * case-folds only when comparing as Windows. It does not resolve symlinks or
 * check whether either path exists.
 */
export function areEquivalentPaths(left: string, right: string): boolean {
  const compareAsWindows = shouldCompareAsWindows(left, right);
  return (
    normalizePathForComparison(left, compareAsWindows) ===
    normalizePathForComparison(right, compareAsWindows)
  );
}

export function createPathEquivalenceMatcher(target: string): (candidate: string) => boolean {
  const targetLooksWindows = looksLikeDefiniteWindowsPath(target);
  const compareAsWindows = targetLooksWindows;
  const normalizedTarget = normalizePathForComparison(target, compareAsWindows);

  return (candidate) => {
    const candidateCompareAsWindows = compareAsWindows || looksLikeDefiniteWindowsPath(candidate);
    const comparableTarget =
      candidateCompareAsWindows === compareAsWindows
        ? normalizedTarget
        : normalizePathForComparison(target, candidateCompareAsWindows);
    return normalizePathForComparison(candidate, candidateCompareAsWindows) === comparableTarget;
  };
}

export function createRealpathAwarePathMatcher(target: string): (candidate: string) => boolean {
  const targetMatchers = collectPathVariants(target).map((variant) =>
    createPathEquivalenceMatcher(variant),
  );

  return (candidate) => {
    const candidateVariants = collectPathVariants(candidate);
    return candidateVariants.some((variant) => targetMatchers.some((matches) => matches(variant)));
  };
}

export function isPathInsideRoot(root: string, candidate: string): boolean {
  return getRelativePathInsideRoot(root, candidate) !== null;
}

/**
 * Returns the candidate's relative suffix when it is inside root.
 *
 * The suffix is derived from the same lexical path pair used to prove
 * containment. Callers that map an existing filesystem path into a new root
 * must keep those two operations coupled.
 */
export function getRealpathAwareRelativePath(root: string, candidate: string): string | null {
  const rootVariants = collectPathVariants(root);
  const candidateVariants = collectPathVariants(candidate);

  for (const rootVariant of rootVariants) {
    for (const candidateVariant of candidateVariants) {
      const relativePath = getRelativePathInsideRoot(rootVariant, candidateVariant);
      if (relativePath !== null) return relativePath;
    }
  }

  return null;
}

export function isRealpathInsideRoot(root: string, candidate: string): boolean {
  return getRealpathAwareRelativePath(root, candidate) !== null;
}

function getRelativePathInsideRoot(root: string, candidate: string): string | null {
  const compareAsWindows = shouldCompareAsWindows(root, candidate);
  const platformPath = compareAsWindows ? nodePath.win32 : nodePath.posix;
  const normalizedRoot = normalizePathForComparison(root, compareAsWindows);
  const normalizedCandidate = normalizePathForComparison(candidate, compareAsWindows);
  const relative = platformPath.relative(normalizedRoot, normalizedCandidate);

  return relative === "" || (!relative.startsWith("..") && !platformPath.isAbsolute(relative))
    ? relative
    : null;
}

function collectPathVariants(value: string): string[] {
  const variants = new Set<string>([value]);
  for (const realpath of resolveRealpathVariants(value)) {
    variants.add(realpath);
  }
  return Array.from(variants);
}

function resolveRealpathVariants(value: string): string[] {
  const variants: string[] = [];
  try {
    variants.push(realpathSync.native(value));
  } catch {
    // Path may not exist, or the platform may reject this link flavor.
  }
  try {
    variants.push(realpathSync(value));
  } catch {
    // Keep string-only comparison as the fallback.
  }
  return variants;
}

function shouldCompareAsWindows(left: string, right: string): boolean {
  return looksLikeDefiniteWindowsPath(left) || looksLikeDefiniteWindowsPath(right);
}

function looksLikeDefiniteWindowsPath(value: string): boolean {
  return (
    /^[a-zA-Z]:[\\/]/u.test(value) ||
    /^[/\\]{2}\?[/\\]/u.test(value) ||
    /^\\{2}[^/\\]+[/\\][^/\\]+/u.test(value)
  );
}

function normalizePathForComparison(value: string, compareAsWindows: boolean): string {
  const platformPath = compareAsWindows ? nodePath.win32 : nodePath.posix;
  const comparableValue = compareAsWindows ? stripWindowsNamespacePrefix(value) : value;
  const platformNormalized = platformPath.normalize(comparableValue);
  const normalized = stripTrailingSeparators(
    platformNormalized,
    platformPath.parse(platformNormalized).root,
    compareAsWindows,
  );
  return compareAsWindows ? normalized.toLowerCase() : normalized;
}

function stripWindowsNamespacePrefix(value: string): string {
  const driveMatch = value.match(/^[/\\]{2}\?[/\\]([a-zA-Z]:)[/\\](.*)$/u);
  const drivePrefix = driveMatch?.[1];
  if (drivePrefix) {
    return `${drivePrefix}\\${driveMatch[2] ?? ""}`;
  }

  const uncMatch = value.match(/^[/\\]{2}\?[/\\]UNC[/\\]([^/\\]+)[/\\]([^/\\]+)(?:[/\\](.*))?$/iu);
  const uncServer = uncMatch?.[1];
  const uncShare = uncMatch?.[2];
  if (uncServer && uncShare) {
    const uncRest = uncMatch[3];
    return `\\\\${uncServer}\\${uncShare}${uncRest !== undefined ? `\\${uncRest}` : ""}`;
  }

  return value;
}

function stripTrailingSeparators(value: string, root: string, compareAsWindows: boolean): string {
  const separatorPattern = compareAsWindows ? /[\\/]/u : /\//u;
  let result = value;
  while (result.length > root.length && separatorPattern.test(result.at(-1) ?? "")) {
    result = result.slice(0, -1);
  }
  return result;
}
