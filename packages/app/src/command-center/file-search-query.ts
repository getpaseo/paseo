import { isAbsolutePath, isHomeRelativePath, isPathWithinRoot } from "@/utils/path";

/**
 * A `getDirectorySuggestions` call. The daemon takes a root plus a query relative to that root, and
 * a workspace is the only root it already knows about — so a path typed outside the workspace has
 * to borrow the typed path's own directory as the root.
 */
export interface DaemonFileSearchRequest {
  /** Directory the daemon searches under. */
  cwd: string;
  /** Query to run inside that directory. */
  query: string;
  /** Prefix that turns a suggested path back into the path the user is opening. */
  root: string;
}

export interface DaemonFileSearchPlan {
  /** Lists matches around the typed path. */
  list: DaemonFileSearchRequest;
  /**
   * Retrieves the typed path itself. Discovery drops hidden and Git-ignored names, so the exact
   * file the caller named needs a retrieval request of its own: `matchMode: "suffix"` with the
   * path spelled out is the daemon's supported way to resolve a named entry.
   */
  exact: DaemonFileSearchRequest | null;
  /** The path the user typed, collapsed: the only path `exact` may legitimately return. */
  namedPath: string;
}

const TRAILING_SEPARATORS = /\/+$/;
const DRIVE_LETTER = /^[A-Za-z]:$/;

/**
 * Collapses `.` and `..` lexically, so containment is judged on the path the daemon will resolve:
 * `/code/app/../other/plan.md` starts with the workspace but does not stay in it.
 */
function collapsePathSegments(value: string): string {
  // A UNC path carries host and share segments that `..` must not pop, so leave it as typed.
  if (value.startsWith("//")) {
    return value;
  }
  const drive = /^([A-Za-z]:)\//.exec(value);
  let prefix = "";
  if (drive) {
    prefix = `${drive[1]}/`;
  } else if (value.startsWith("/")) {
    prefix = "/";
  }
  const collapsed: string[] = [];
  for (const segment of value.slice(prefix.length).split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      collapsed.pop();
      continue;
    }
    collapsed.push(segment);
  }
  return prefix + collapsed.join("/");
}

/** On Windows a bare `C:` means "the current directory on drive C", so keep the separator. */
function toDirectoryRoot(value: string): string {
  if (DRIVE_LETTER.test(value)) {
    return `${value}/`;
  }
  return value || "/";
}

/**
 * Plans the daemon calls for an absolute or `~`-relative query, or null when the active workspace
 * already answers it. Absolute queries inside the workspace stay untouched: the daemon resolves
 * those itself and returns workspace-relative paths, which is what file rows and tabs expect.
 */
export function planDaemonFileSearchRequest(input: {
  query: string;
  workspaceRoot?: string | null;
}): DaemonFileSearchPlan | null {
  const typed = input.query.trim().replace(/\\/g, "/");
  if (!typed) {
    return null;
  }
  const homeRelative = isHomeRelativePath(typed);
  if (!homeRelative && !isAbsolutePath(typed)) {
    return null;
  }

  const collapsed = collapsePathSegments(typed);
  const workspaceRoot = input.workspaceRoot?.trim().replace(/\\/g, "/") ?? "";
  if (!homeRelative && workspaceRoot && isPathWithinRoot(collapsed, workspaceRoot)) {
    return null;
  }

  const browsed = collapsed.replace(TRAILING_SEPARATORS, "");
  if (!browsed || browsed === "~" || TRAILING_SEPARATORS.test(typed)) {
    const root = toDirectoryRoot(browsed);
    return { list: { cwd: root, query: "", root }, exact: null, namedPath: collapsed };
  }

  const separator = browsed.lastIndexOf("/");
  let parent = homeRelative ? "~" : "/";
  if (separator > 0) {
    parent = browsed.slice(0, separator);
  }
  const root = toDirectoryRoot(parent);
  const name = browsed.slice(separator + 1);
  return {
    list: { cwd: root, query: name, root },
    exact: { cwd: root, query: `./${name}`, root },
    namedPath: collapsed,
  };
}

function pathsEqual(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const withoutTrailing = value.replace(/\/+$/, "");
    return /^[A-Za-z]:\//.test(withoutTrailing)
      ? `${withoutTrailing.slice(0, 1).toUpperCase()}${withoutTrailing.slice(1)}`
      : withoutTrailing;
  };
  return normalize(left) === normalize(right);
}

/**
 * True only for the path the user typed. The retrieval request falls back to a suffix search when
 * the named path does not exist, and that search can offer a same-named file deeper under the root
 * — opening that instead of the typed path would be wrong, so it is filtered out.
 */
export function isNamedFileSuggestion(input: {
  root: string;
  path: string;
  namedPath: string;
}): boolean {
  return pathsEqual(
    resolveSuggestedFilePath({ root: input.root, path: input.path }),
    input.namedPath,
  );
}

/** Rebuilds an openable path from a suggestion the daemon returned relative to `root`. */
export function resolveSuggestedFilePath(input: { root: string; path: string }): string {
  const relative = input.path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!relative || relative === ".") {
    return input.root;
  }
  return input.root.endsWith("/") ? `${input.root}${relative}` : `${input.root}/${relative}`;
}
