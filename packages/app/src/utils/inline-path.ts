export interface InlinePathTarget {
  raw: string;
  path: string;
  lineStart?: number;
  lineEnd?: number;
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

