import { isAbsolutePath } from "./path";

export interface InlinePathTarget {
  raw: string;
  path: string;
  lineStart?: number;
  lineEnd?: number;
}

const FILE_PROTOCOL = "file:";
const INLINE_LINE_FRAGMENT = /^L([0-9]+)(?:-L?([0-9]+))?$/i;

export interface AssistantHrefParseOptions {
  workspaceRoot?: string;
}

export interface NormalizedInlinePathTarget {
  directory: string;
  file?: string;
}

function normalizePathToken(value: string): string | null {
  const trimmed = value
    .trim()
    .replace(/^['"`]/, "")
    .replace(/['"`]$/, "");

  if (!trimmed) {
    return null;
  }

  return trimmed.replace(/\\/g, "/");
}

function parseLineFragment(value: string): Pick<InlinePathTarget, "lineStart" | "lineEnd"> | null {
  const rawFragment = value.startsWith("#") ? value.slice(1) : value;
  if (!rawFragment) {
    return { lineStart: undefined, lineEnd: undefined };
  }

  const lineMatch = rawFragment.match(INLINE_LINE_FRAGMENT);
  const lineStart = lineMatch?.[1] ? parseInt(lineMatch[1], 10) : undefined;
  const lineEnd = lineMatch?.[2] ? parseInt(lineMatch[2], 10) : undefined;

  if (
    (lineStart !== undefined && (!Number.isFinite(lineStart) || lineStart <= 0)) ||
    (lineEnd !== undefined && (!Number.isFinite(lineEnd) || lineEnd <= 0)) ||
    (lineStart !== undefined && lineEnd !== undefined && lineEnd < lineStart)
  ) {
    return null;
  }

  return { lineStart, lineEnd };
}

/**
 * Strict VSCode-style markers only.
 *
 * Supported:
 * - `filename:linenumber`
 * - `filename:lineStart-lineEnd`
 *
 * Not supported (by design):
 * - plain `filename` (no line)
 * - `:linenumber` (range-only)
 */
export function parseInlinePathToken(value: string): InlinePathTarget | null {
  const rawValue = value ?? "";
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return null;
  }

  const match = trimmed.match(/^(.+?):([0-9]+)(?:-([0-9]+))?$/);
  if (!match) {
    return null;
  }

  const basePathRaw = match[1]?.trim();
  if (!basePathRaw) {
    return null;
  }

  // Avoid accidentally treating URLs as file paths.
  if (basePathRaw.includes("://")) {
    return null;
  }

  const normalizedPath = normalizePathToken(basePathRaw);
  if (!normalizedPath) {
    return null;
  }

  const lineStart = parseInt(match[2], 10);
  if (!Number.isFinite(lineStart) || lineStart <= 0) {
    return null;
  }

  const lineEnd = match[3] ? parseInt(match[3], 10) : undefined;
  if (lineEnd !== undefined) {
    if (!Number.isFinite(lineEnd) || lineEnd <= 0) {
      return null;
    }
    if (lineEnd < lineStart) {
      return null;
    }
  }

  return {
    raw: rawValue,
    path: normalizedPath,
    lineStart,
    lineEnd,
  };
}

export function parseFileProtocolUrl(value: string): InlinePathTarget | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsedUrl.protocol !== FILE_PROTOCOL) {
    return null;
  }

  const normalizedPath = normalizeFileUrlPath(parsedUrl.pathname);
  if (!normalizedPath) {
    return null;
  }

  const lines = parseLineFragment(parsedUrl.hash);
  if (!lines) {
    return null;
  }

  return {
    raw: value,
    path: normalizedPath,
    ...lines,
  };
}

export function parseAssistantFileLink(
  value: string,
  options: AssistantHrefParseOptions = {},
): InlinePathTarget | null {
  const fileUrlTarget = parseFileProtocolUrl(value);
  if (fileUrlTarget) {
    return fileUrlTarget;
  }

  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.includes("://")) {
    return null;
  }

  const windowsPathMatch = trimmed.match(/^([A-Za-z]:[\\/][^?#]*)(#[^?]+)?$/);
  if (windowsPathMatch) {
    const normalizedPath = normalizePathToken(windowsPathMatch[1] ?? "");
    if (!normalizedPath || !isAllowedAbsolutePath(normalizedPath, options.workspaceRoot)) {
      return null;
    }

    const lines = parseLineFragment(windowsPathMatch[2] ?? "");
    if (!lines) {
      return null;
    }

    return {
      raw: value,
      path: normalizedPath,
      ...lines,
    };
  }

  if (!isAbsolutePath(trimmed)) {
    return null;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed, "http://paseo.invalid");
  } catch {
    return null;
  }

  const normalizedPath = normalizePathToken(decodeURIComponent(parsedUrl.pathname));
  if (!normalizedPath || !isAbsolutePath(normalizedPath)) {
    return null;
  }

  if (!isAllowedAbsolutePath(normalizedPath, options.workspaceRoot)) {
    return null;
  }

  const lines = parseLineFragment(parsedUrl.hash);
  if (!lines) {
    return null;
  }

  return {
    raw: value,
    path: normalizedPath,
    ...lines,
  };
}

export function normalizeInlinePathTarget(
  rawPath: string,
  cwd?: string,
): NormalizedInlinePathTarget | null {
  if (!rawPath) {
    return null;
  }

  const normalizedInput = normalizePathInput(rawPath);
  if (!normalizedInput) {
    return null;
  }

  let normalized = normalizedInput;
  const cwdRelative = resolvePathAgainstCwd(normalized, cwd);
  if (cwdRelative) {
    normalized = cwdRelative;
  }

  if (normalized.startsWith("./")) {
    normalized = normalized.slice(2) || ".";
  }

  if (!normalized.length) {
    normalized = ".";
  }

  if (normalized === ".") {
    return { directory: "." };
  }

  if (normalized.endsWith("/")) {
    const dir = normalized.replace(/\/+$/, "");
    return { directory: dir.length > 0 ? dir : "." };
  }

  const lastSlash = normalized.lastIndexOf("/");
  const directory = lastSlash >= 0 ? normalized.slice(0, lastSlash) : ".";

  return {
    directory: directory.length > 0 ? directory : ".",
    file: normalized,
  };
}

function isAllowedAbsolutePath(pathValue: string, workspaceRoot?: string): boolean {
  const normalizedWorkspaceRoot = normalizePathInput(workspaceRoot);
  if (!normalizedWorkspaceRoot) {
    return true;
  }

  const comparePath = normalizePathForCompare(pathValue);
  const compareWorkspaceRoot = normalizePathForCompare(
    normalizedWorkspaceRoot.replace(/\/+$/, "") || "/",
  );
  const comparePrefix = compareWorkspaceRoot === "/" ? "/" : `${compareWorkspaceRoot}/`;

  return comparePath === compareWorkspaceRoot || comparePath.startsWith(comparePrefix);
}

function normalizeFileUrlPath(pathname: string): string | null {
  if (!pathname) {
    return null;
  }

  const decoded = decodeURIComponent(pathname).replace(/\\/g, "/");
  if (!decoded) {
    return null;
  }

  if (/^\/[A-Za-z]:\//.test(decoded)) {
    return decoded.slice(1);
  }

  return decoded;
}

function normalizePathInput(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value
    .trim()
    .replace(/^['"`]/, "")
    .replace(/['"`]$/, "");
  if (!trimmed) {
    return null;
  }

  return trimmed.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

function resolvePathAgainstCwd(pathValue: string, cwd?: string): string | null {
  const normalizedCwd = normalizePathInput(cwd);
  if (!normalizedCwd || !isAbsolutePath(pathValue) || !isAbsolutePath(normalizedCwd)) {
    return null;
  }

  const normalizedCwdBase = normalizedCwd.replace(/\/+$/, "") || "/";
  const comparePath = normalizePathForCompare(pathValue);
  const compareCwd = normalizePathForCompare(normalizedCwdBase);
  const prefix = normalizedCwdBase === "/" ? "/" : `${normalizedCwdBase}/`;
  const comparePrefix = normalizePathForCompare(prefix);

  if (comparePath === compareCwd) {
    return ".";
  }

  if (comparePath.startsWith(comparePrefix)) {
    return pathValue.slice(prefix.length) || ".";
  }

  return null;
}

function normalizePathForCompare(value: string): string {
  return /^[A-Za-z]:/.test(value) ? value.toLowerCase() : value;
}
