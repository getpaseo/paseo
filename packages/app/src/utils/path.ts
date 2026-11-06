export function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(value);
}

export function isHomeRelativePath(value: string): boolean {
  return value === "~" || value.startsWith("~/") || value.startsWith("~\\");
}

/**
 * Collapses `.` and `..` lexically, so containment is judged on the path the daemon will resolve:
 * `/code/app/../other/plan.md` starts with the workspace but does not stay in it. Home is a prefix
 * rather than a directory: `~/../other` keeps the `~` so the daemon still expands it from `$HOME`.
 */
export function collapsePathSegments(value: string): string {
  // A UNC path carries host and share segments that `..` must not pop, so leave it as typed.
  if (value.startsWith("//")) {
    return value;
  }
  const drive = /^([A-Za-z]:)\//.exec(value);
  const homeRelative = value === "~" || value.startsWith("~/");
  let prefix = "";
  let rest = value;
  if (drive) {
    prefix = `${drive[1]}/`;
    rest = value.slice(prefix.length);
  } else if (value.startsWith("/")) {
    prefix = "/";
    rest = value.slice(1);
  } else if (homeRelative) {
    prefix = "~/";
    rest = value === "~" ? "" : value.slice(2);
  }
  const collapsed: string[] = [];
  for (const segment of rest.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      const last = collapsed[collapsed.length - 1];
      if (last && last !== "..") {
        collapsed.pop();
      } else if (homeRelative) {
        // `~` is not a filesystem root, so leftover `..` has to stay until the daemon expands it.
        collapsed.push("..");
      }
      continue;
    }
    collapsed.push(segment);
  }
  const joined = collapsed.join("/");
  if (homeRelative && !joined) {
    return "~";
  }
  return prefix + joined;
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
