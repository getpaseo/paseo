import { isAbsolutePath } from "@/utils/path";

export type OpenFileDisposition = "main" | "side";

export interface WorkspaceFileLocation {
  path: string;
  lineStart?: number;
  lineEnd?: number;
}

export type WorkspaceFileTabTarget = { kind: "file" } & WorkspaceFileLocation;

export interface WorkspaceFileOpenRequest {
  location: WorkspaceFileLocation;
  disposition: OpenFileDisposition;
}

export function normalizeWorkspaceFileLocation(
  location: WorkspaceFileLocation | null | undefined,
): WorkspaceFileLocation | null {
  if (!location) {
    return null;
  }

  const path = location.path.trim().replace(/\\/g, "/");
  if (!path) {
    return null;
  }

  const lineStart = normalizeLineNumber(location.lineStart);
  const lineEnd = normalizeLineNumber(location.lineEnd);
  return {
    path,
    ...(lineStart ? { lineStart } : {}),
    ...(lineStart && lineEnd && lineEnd >= lineStart ? { lineEnd } : {}),
  };
}

export function workspaceFileLocationsEqual(
  left: WorkspaceFileLocation,
  right: WorkspaceFileLocation,
): boolean {
  return (
    left.path === right.path && left.lineStart === right.lineStart && left.lineEnd === right.lineEnd
  );
}

export function createWorkspaceFileTabTarget(
  location: WorkspaceFileLocation,
): WorkspaceFileTabTarget {
  return {
    kind: "file",
    ...location,
  };
}

function normalizeLineNumber(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function trimTrailingSlashes(value: string): string {
  if (value === "/" || /^\/+$/.test(value)) {
    return "/";
  }
  if (/^[A-Za-z]:\/+$/.test(value)) {
    return `${value.slice(0, 2)}/`;
  }
  return value.replace(/\/+$/, "");
}

function normalizePathSegments(value: string, rejectEscape: boolean): string | null {
  const segments: string[] = [];
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        if (rejectEscape) {
          return null;
        }
        continue;
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

function normalizeAbsolutePath(value: string): string | null {
  const normalizedInput = trimTrailingSlashes(value);
  if (!isAbsolutePath(normalizedInput)) {
    return null;
  }

  const drivePath = /^([A-Za-z]:)\/(.*)$/.exec(normalizedInput);
  if (drivePath) {
    const normalizedBody = normalizePathSegments(drivePath[2], false);
    return trimTrailingSlashes(`${drivePath[1]}/${normalizedBody}`);
  }

  const prefix = normalizedInput.startsWith("//") ? "//" : "/";
  const normalizedBody = normalizePathSegments(normalizedInput.replace(/^\/+/, ""), false);
  return trimTrailingSlashes(`${prefix}${normalizedBody}`);
}

function normalizeRelativePath(value: string): string | null {
  const normalized = normalizePathSegments(value.replace(/^\/+/, ""), true);
  return normalized || null;
}

function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:\//.test(value);
}

function pathsEqual(left: string, right: string): boolean {
  return isWindowsPath(left) || isWindowsPath(right)
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function startsWithPath(value: string, prefix: string): boolean {
  return isWindowsPath(value) || isWindowsPath(prefix)
    ? value.toLowerCase().startsWith(prefix.toLowerCase())
    : value.startsWith(prefix);
}

export interface ResolvedWorkspaceFilePaths {
  /** Absolute path on the host, suitable for opening in an editor / file manager. */
  absolutePath: string;
  /** Path relative to the workspace root, or null when the file lives outside it. */
  relativePath: string | null;
}

/**
 * Resolves a file tab's path (which may be workspace-relative) against the workspace
 * root. Returns null when an absolute host path cannot be derived — e.g. a `~`-relative
 * path or a relative path with no workspace root to anchor it.
 */
export function resolveWorkspaceFilePaths(input: {
  path: string;
  workspaceRoot: string;
}): ResolvedWorkspaceFilePaths | null {
  const filePath = input.path.trim().replace(/\\/g, "/");
  const workspaceRoot = normalizeAbsolutePath(input.workspaceRoot.trim().replace(/\\/g, "/"));
  if (!filePath || !workspaceRoot) {
    return null;
  }

  if (isAbsolutePath(filePath)) {
    const normalizedFile = normalizeAbsolutePath(filePath);
    if (!normalizedFile) {
      return null;
    }
    if (pathsEqual(normalizedFile, workspaceRoot)) {
      return null;
    }
    const prefix = `${workspaceRoot}/`;
    const relativePath = startsWithPath(normalizedFile, prefix)
      ? normalizedFile.slice(prefix.length)
      : null;
    return { absolutePath: normalizedFile, relativePath };
  }

  if (filePath === "~" || filePath.startsWith("~/")) {
    return null;
  }

  const relativePath = normalizeRelativePath(filePath);
  if (!relativePath) {
    return null;
  }
  return { absolutePath: `${workspaceRoot}/${relativePath}`, relativePath };
}
