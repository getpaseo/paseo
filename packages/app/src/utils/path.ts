export function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(value);
}

export function isHomeRelativePath(value: string): boolean {
  return value === "~" || value.startsWith("~/") || value.startsWith("~\\");
}

function trimTrailingSeparators(value: string): string {
  if (value === "/" || /^[A-Za-z]:[\\/]?$/.test(value)) {
    return value.replace(/\\/g, "/");
  }
  return value.replace(/[\\/]+$/, "");
}

function normalizeForPathComparison(value: string): string {
  const normalized = trimTrailingSeparators(value.replace(/\\/g, "/"));
  if (/^[A-Za-z]:\//.test(normalized)) {
    return `${normalized.slice(0, 1).toUpperCase()}${normalized.slice(1)}`;
  }
  return normalized;
}

/**
 * Lexical containment check used to decide whether a path the user typed belongs to a workspace.
 * It never touches the filesystem: separators are normalized, trailing separators dropped, and
 * Windows drive letters case-folded. Callers that need symlink or `..` semantics must resolve the
 * path first.
 */
export function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  const candidate = normalizeForPathComparison(candidatePath);
  const root = normalizeForPathComparison(rootPath);
  if (!candidate || !root) {
    return false;
  }
  if (root === "/") {
    return candidate.startsWith("/");
  }
  if (candidate === root) {
    return true;
  }
  return candidate.startsWith(`${root}/`);
}
