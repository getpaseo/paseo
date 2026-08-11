import { resolve, sep } from "node:path";

export interface ObserverPaths {
  isInside(root: string, path: string): boolean;
  normalizeIgnoredRoots(root: string, paths: string[]): string[];
  collapse(paths: string[]): string[];
  isExpectedWatchDisappearance(error: unknown): boolean;
}

export function createObserverPaths(platform: NodeJS.Platform): ObserverPaths {
  function comparable(path: string): string {
    return platform === "win32" ? path.toLowerCase() : path;
  }

  function isInside(root: string, path: string): boolean {
    const comparedRoot = comparable(root);
    const comparedPath = comparable(path);
    return comparedPath === comparedRoot || comparedPath.startsWith(`${comparedRoot}${sep}`);
  }

  function collapse(paths: string[]): string[] {
    return [...new Set(paths)]
      .sort((left, right) => left.length - right.length)
      .filter((path, index, all) => !all.slice(0, index).some((parent) => isInside(parent, path)));
  }

  return {
    isInside,
    collapse,
    normalizeIgnoredRoots(root, paths) {
      const inside = paths
        .map((path) => resolve(path))
        .filter((path) => path !== root && isInside(root, path));
      return collapse(inside);
    },
    isExpectedWatchDisappearance(error) {
      const code = getErrorCode(error);
      return code === "ENOENT" || (platform === "win32" && code === "EPERM");
    },
  };
}

export function isMissingPathError(error: unknown): boolean {
  const code = getErrorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function getErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}
