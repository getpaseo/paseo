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

export interface RealpathAwarePathContext {
  matches(left: string, right: string): boolean;
  relative(root: string, candidate: string): string | null;
  inside(root: string, candidate: string): boolean;
}

/** Resolve each path once during a synchronous event batch; discard before the next batch. */
export function createRealpathAwarePathContext(
  readVariants: (path: string) => readonly string[] = collectPathVariants,
): RealpathAwarePathContext {
  const cached = new Map<string, readonly string[]>();
  const prepared = new Map<
    string,
    { text: string; comparable: string; prefix: string; absolute: boolean }
  >();
  const variants = (path: string): readonly string[] => {
    let values = cached.get(path);
    if (!values) {
      values = readVariants(path);
      cached.set(path, values);
    }
    return values;
  };
  const prepare = (path: string, windows: boolean) => {
    const key = `${windows ? "windows" : "posix"}:${path}`;
    let value = prepared.get(key);
    if (!value) {
      const text = normalizePathPreservingCase(path, windows);
      const comparable = windows ? text.toLowerCase() : text;
      const separator = windows ? "\\" : "/";
      value = {
        text,
        comparable,
        prefix: comparable.endsWith(separator) ? comparable : `${comparable}${separator}`,
        absolute:
          (windows ? nodePath.win32 : nodePath.posix).isAbsolute(text) &&
          (!windows || looksLikeDefiniteWindowsPath(text)),
      };
      prepared.set(key, value);
    }
    return value;
  };
  const relative = (root: string, candidate: string): string | null => {
    for (const rootVariant of variants(root)) {
      for (const candidateVariant of variants(candidate)) {
        const windows = shouldCompareAsWindows(rootVariant, candidateVariant);
        const a = prepare(rootVariant, windows);
        const b = prepare(candidateVariant, windows);
        let suffix: string | null;
        if (!a.absolute || !b.absolute) {
          suffix = getRelativePathInsideRoot(rootVariant, candidateVariant);
        } else if (a.comparable === b.comparable) {
          suffix = "";
        } else if (b.comparable.startsWith(a.prefix)) {
          suffix = b.text.slice(a.text.length + (a.prefix.length > a.comparable.length ? 1 : 0));
          if (suffix.startsWith("..")) suffix = null;
        } else {
          suffix = null;
        }
        if (suffix !== null) return suffix;
      }
    }
    return null;
  };
  return {
    matches: (left, right) =>
      variants(left).some((a) =>
        variants(right).some((b) => {
          const windows = shouldCompareAsWindows(a, b);
          return prepare(a, windows).comparable === prepare(b, windows).comparable;
        }),
      ),
    relative,
    inside: (root, candidate) => relative(root, candidate) !== null,
  };
}

let pathContainmentChecks: number | null = null;

// Containment is re-derived from scratch on every call. A tree walk that asks it per entry, or
// per ancestor of every entry, costs more than reading the tree does, so tests count the calls.
export function startPathContainmentMetrics(): void {
  pathContainmentChecks = 0;
}

export function stopPathContainmentMetrics(): number {
  const checks = pathContainmentChecks ?? 0;
  pathContainmentChecks = null;
  return checks;
}

export function isPathInsideRoot(root: string, candidate: string): boolean {
  if (pathContainmentChecks !== null) pathContainmentChecks += 1;
  return getRelativePathInsideRoot(root, candidate) !== null;
}

export function normalizePathForIdentity(value: string): string {
  const canonicalPath = resolveRealpathVariants(value)[0] ?? value;
  return normalizePathForComparison(canonicalPath, looksLikeDefiniteWindowsPath(canonicalPath));
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
  const comparableRelative = platformPath.relative(normalizedRoot, normalizedCandidate);

  if (
    comparableRelative !== "" &&
    (comparableRelative.startsWith("..") || platformPath.isAbsolute(comparableRelative))
  ) {
    return null;
  }

  const casePreservingRoot = normalizePathPreservingCase(root, compareAsWindows);
  const casePreservingCandidate = normalizePathPreservingCase(candidate, compareAsWindows);
  return platformPath.relative(casePreservingRoot, casePreservingCandidate);
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

/**
 * True when `value`'s shape identifies it as a Windows path (drive letter,
 * `\\?\` device namespace, or UNC), independent of the host platform. Callers
 * that fold case for Windows-looking paths (this module's own comparisons,
 * and `pruneKnownDirectories` in `workspace-git-service.ts`, which needs the
 * same decision without paying for a realpath syscall) must all agree on this
 * one rule — do not reimplement the pattern.
 */
export function looksLikeDefiniteWindowsPath(value: string): boolean {
  return (
    /^[a-zA-Z]:[\\/]/u.test(value) ||
    /^[/\\]{2}\?[/\\]/u.test(value) ||
    /^\\{2}[^/\\]+[/\\][^/\\]+/u.test(value)
  );
}

function normalizePathForComparison(value: string, compareAsWindows: boolean): string {
  const normalized = normalizePathPreservingCase(value, compareAsWindows);
  return compareAsWindows ? normalized.toLowerCase() : normalized;
}

function normalizePathPreservingCase(value: string, compareAsWindows: boolean): string {
  const platformPath = compareAsWindows ? nodePath.win32 : nodePath.posix;
  const comparableValue = compareAsWindows ? stripWindowsNamespacePrefix(value) : value;
  const platformNormalized = platformPath.normalize(comparableValue);
  return stripTrailingSeparators(
    platformNormalized,
    platformPath.parse(platformNormalized).root,
    compareAsWindows,
  );
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
