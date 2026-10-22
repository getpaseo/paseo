/**
 * Pure path math for the file-pane breadcrumb.
 *
 * The breadcrumb shows the file path relative to the workspace root (or the
 * absolute path when the file lives outside it). Every segment knows which
 * directory its dropdown should list, so clicking the file name lists its
 * siblings and clicking a parent segment lists that parent's entries.
 */

export interface FileBreadcrumbSegment {
  label: string;
  /** Absolute directory this segment's dropdown lists. */
  directory: string;
}

export interface FileBreadcrumb {
  /** Path shown in the strip: workspace-relative when possible. */
  displayPath: string;
  absolutePath: string;
  /** Absolute directory containing the file. */
  directory: string;
  insideWorkspace: boolean;
  segments: FileBreadcrumbSegment[];
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:\//.test(value);
}

export function normalizeSlashes(value: string): string {
  const trimmed = value.trim().replace(/\\/g, "/");
  if (!trimmed) {
    return "";
  }
  const collapsed = trimmed.replace(/\/{2,}/g, "/");
  if (collapsed === "/" || /^[A-Za-z]:\/$/.test(collapsed)) {
    return collapsed;
  }
  return collapsed.replace(/\/+$/, "");
}

function pathsEqual(left: string, right: string): boolean {
  return isWindowsAbsolutePath(left) || isWindowsAbsolutePath(right)
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function isInsidePath(child: string, parent: string): boolean {
  if (pathsEqual(child, parent)) {
    return true;
  }
  const prefix = parent.endsWith("/") ? parent : `${parent}/`;
  return isWindowsAbsolutePath(child) || isWindowsAbsolutePath(parent)
    ? child.toLowerCase().startsWith(prefix.toLowerCase())
    : child.startsWith(prefix);
}

/** Absolute parent directory. `/a` -> `/`, `C:/a` -> `C:/`, `/a/b` -> `/a`. */
export function dirnamePath(value: string): string {
  const path = normalizeSlashes(value);
  const separator = path.lastIndexOf("/");
  if (separator < 0) {
    return ".";
  }
  if (separator === 0) {
    return "/";
  }
  const head = path.slice(0, separator);
  if (/^[A-Za-z]:$/.test(head)) {
    return `${head}/`;
  }
  return head;
}

function climb(directory: string, levels: number): string {
  let current = directory;
  for (let index = 0; index < levels; index += 1) {
    current = dirnamePath(current);
  }
  return current;
}

export function joinAbsolutePath(directory: string, name: string): string {
  const base = normalizeSlashes(directory);
  const leaf = normalizeSlashes(name).replace(/^\/+/, "");
  if (!base || base === "/") {
    return `/${leaf}`;
  }
  return `${base.replace(/\/+$/, "")}/${leaf}`;
}

/**
 * Resolve a file path (workspace-relative or absolute) into breadcrumb data.
 * Returns null for an empty path or a workspace root that is not absolute.
 */
export function resolveFileBreadcrumb(input: {
  filePath: string;
  workspaceRoot: string;
}): FileBreadcrumb | null {
  const filePath = normalizeSlashes(input.filePath);
  const workspaceRoot = normalizeSlashes(input.workspaceRoot);
  if (!filePath || !workspaceRoot) {
    return null;
  }
  if (!workspaceRoot.startsWith("/") && !isWindowsAbsolutePath(workspaceRoot)) {
    return null;
  }

  const absolutePath =
    filePath.startsWith("/") || isWindowsAbsolutePath(filePath)
      ? filePath
      : joinAbsolutePath(workspaceRoot, filePath);
  if (pathsEqual(absolutePath, workspaceRoot)) {
    return null;
  }

  const insideWorkspace = isInsidePath(absolutePath, workspaceRoot);
  const displayPath = insideWorkspace
    ? absolutePath.slice(
        workspaceRoot.endsWith("/") ? workspaceRoot.length : workspaceRoot.length + 1,
      )
    : absolutePath;
  const labels = displayPath.split("/").filter(Boolean);
  if (labels.length === 0) {
    return null;
  }

  const directory = dirnamePath(absolutePath);
  const lastIndex = labels.length - 1;
  const segments = labels.map((label, index) => ({
    label,
    directory: index === lastIndex ? directory : climb(directory, lastIndex - index - 1),
  }));

  return {
    displayPath,
    absolutePath,
    directory,
    insideWorkspace,
    segments,
  };
}

/** True when `directory` is `root` or one of its descendants. */
export function isDirectoryWithin(directory: string, root: string): boolean {
  return isInsidePath(normalizeSlashes(directory), normalizeSlashes(root));
}

/**
 * Path to hand to the workspace file opener: workspace-relative when the file
 * is inside the workspace, absolute otherwise.
 */
export function toWorkspaceFileOpenPath(absolutePath: string, workspaceRoot: string): string {
  const breadcrumb = resolveFileBreadcrumb({ filePath: absolutePath, workspaceRoot });
  return breadcrumb?.insideWorkspace ? breadcrumb.displayPath : normalizeSlashes(absolutePath);
}
