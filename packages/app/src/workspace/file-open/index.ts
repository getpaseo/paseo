import { isAbsolutePath, normalizePathSeparators } from "@/utils/path";

export type OpenFileDisposition = "main" | "preferred" | "side";

export interface WorkspaceFileLocation {
  path: string;
  /** One-based source line; CRLF, CR and LF each separate lines. */
  lineStart?: number;
  lineEnd?: number;
  /** One-based UTF-16 column on lineStart. */
  columnStart?: number;
  /** Exclusive UTF-16 column on the same line. */
  columnEnd?: number;
  /** Original saved occurrence; a mismatch reveals the location without selecting text. */
  expectedText?: string;
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

  // The path is an identity the host already produced, so it is kept verbatim: a backslash is a
  // file name character outside Windows, and rewriting it here opened a different file than the
  // one a search result or explorer row named. Callers holding a path scraped out of text
  // normalize it themselves before arriving.
  const path = location.path;
  if (!path) {
    return null;
  }

  const lineStart = normalizeLineNumber(location.lineStart);
  const lineEnd = normalizeLineNumber(location.lineEnd);
  const columnStart = normalizeLineNumber(location.columnStart);
  const columnEnd = normalizeLineNumber(location.columnEnd);
  return {
    path,
    ...(lineStart ? { lineStart } : {}),
    ...(lineStart && columnStart ? { columnStart } : {}),
    ...(lineStart && columnEnd && columnEnd >= (columnStart ?? 1) ? { columnEnd } : {}),
    ...(location.expectedText !== undefined ? { expectedText: location.expectedText } : {}),
    ...(lineStart && lineEnd && lineEnd >= lineStart ? { lineEnd } : {}),
  };
}

export function workspaceFileLocationsEqual(
  left: WorkspaceFileLocation,
  right: WorkspaceFileLocation,
): boolean {
  return (
    left.path === right.path &&
    left.lineStart === right.lineStart &&
    left.lineEnd === right.lineEnd &&
    left.columnStart === right.columnStart &&
    left.columnEnd === right.columnEnd &&
    left.expectedText === right.expectedText
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
  const filePath = normalizePathSeparators(input.path);
  const workspaceRoot = normalizeAbsolutePath(normalizePathSeparators(input.workspaceRoot));
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

/** Resolves a saved location without manufacturing a selection when its text has moved. */
export function resolveWorkspaceFileSelection(
  content: string,
  location: WorkspaceFileLocation,
): { from: number; to: number; changed: boolean } {
  const lines = content.split("\n");
  const index = Math.max(0, Math.min((location.lineStart ?? 1) - 1, lines.length - 1));
  const line = lines[index];
  const offset = lines.slice(0, index).reduce((sum, value) => sum + value.length + 1, 0);
  const from = offset + Math.min((location.columnStart ?? 1) - 1, line.length);
  const endIndex = Math.max(index, Math.min((location.lineEnd ?? index + 1) - 1, lines.length - 1));
  let to = from;
  if (location.columnEnd !== undefined) to = offset + Math.min(location.columnEnd - 1, line.length);
  else if (endIndex > index)
    to =
      lines.slice(0, endIndex).reduce((sum, value) => sum + value.length + 1, 0) +
      lines[endIndex].length;
  const changed =
    location.expectedText !== undefined &&
    (index !== (location.lineStart ?? 1) - 1 || content.slice(from, to) !== location.expectedText);
  return { from, to: changed ? from : to, changed };
}
