/**
 * Recognizing a Paseo-managed worktree from its path.
 *
 * The daemon puts every worktree it creates at `<worktreesRoot>/<project-hash>/<slug>`.
 * `worktreesRoot` comes from the daemon's `worktrees.root` config and defaults to
 * `$PASEO_HOME/worktrees`, so the client cannot guess it — it is reported on
 * `server_info.worktreesRoot` and threaded to the call sites below.
 *
 * Prefer daemon-computed answers when you have them: `projectPlacement.projectKey`
 * for grouping and `checkout.mainRepoRoot` for "which repo was this cut from".
 * These helpers are the fallback for the cases that only ever see a bare cwd.
 */

export interface PaseoWorktreePlacement {
  /** `<worktreesRoot>/<project-hash>/<slug>` — the worktree's own root. */
  worktreePath: string;
  /** `<worktreesRoot>/<project-hash>` — sibling worktrees of the same repo live here. */
  projectWorktreesRoot: string;
  /**
   * The repo the worktree was cut from, when the path alone proves it. Null under the
   * daemon's `<root>/<hash>/<slug>` layout: the project hash is one-way, so only the
   * daemon knows the answer (`checkout.mainRepoRoot`, `projectPlacement`).
   */
  mainRepoRoot: string | null;
}

// COMPAT(worktreesRoot): added in v0.3.0. Daemons before v0.3.0 don't report
// `server_info.worktreesRoot`, so fall back to the path convention they shipped with.
// Remove this constant and the `matchLegacyMarker` branch after 2027-08-04.
const LEGACY_WORKTREE_MARKER = ".paseo/worktrees";

/**
 * Resolves the Paseo worktree a path belongs to, or null when it is an ordinary checkout.
 *
 * `worktreesRoot` is the daemon's resolved worktrees base root. Pass null/undefined only
 * when the daemon did not report one.
 */
export function resolvePaseoWorktreePlacement(
  cwd: string,
  worktreesRoot: string | null | undefined,
): PaseoWorktreePlacement | null {
  const trimmedCwd = cwd.trim();
  if (!trimmedCwd) {
    return null;
  }

  const trimmedRoot = worktreesRoot?.trim();
  return trimmedRoot ? matchWorktreesRoot(trimmedCwd, trimmedRoot) : matchLegacyMarker(trimmedCwd);
}

export function isPaseoWorktreePath(
  cwd: string,
  worktreesRoot: string | null | undefined,
): boolean {
  return resolvePaseoWorktreePlacement(cwd, worktreesRoot) !== null;
}

/**
 * Separators are normalized 1:1 so offsets into the normalized string address the same
 * characters in the original. Slicing the original keeps Windows paths looking like
 * Windows paths.
 */
function toForwardSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:/.test(value) || /^\/\/[^/]+\/[^/]+(?:\/|$)/.test(value);
}

function matchWorktreesRoot(cwd: string, worktreesRoot: string): PaseoWorktreePlacement | null {
  const normalizedRoot = stripTrailingSlashes(toForwardSlashes(worktreesRoot));
  if (!normalizedRoot) {
    return null;
  }

  const normalizedCwd = toForwardSlashes(cwd);
  const usesWindowsPaths = isWindowsPath(normalizedRoot) || isWindowsPath(normalizedCwd);
  const comparableRoot = usesWindowsPaths ? normalizedRoot.toLowerCase() : normalizedRoot;
  const comparableCwd = usesWindowsPaths ? normalizedCwd.toLowerCase() : normalizedCwd;
  if (!comparableCwd.startsWith(`${comparableRoot}/`)) {
    return null;
  }

  // `<hash>/<slug>` is required. A path that stops at the hash is the per-project
  // container, not a worktree, and the base root itself is neither.
  const relativeSegments = normalizedCwd
    .slice(normalizedRoot.length + 1)
    .split("/")
    .filter((segment) => segment.length > 0);
  if (relativeSegments.length < 2) {
    return null;
  }

  const projectWorktreesRootEnd = indexAfterSegments(
    normalizedCwd,
    normalizedRoot.length,
    relativeSegments.slice(0, 1),
  );
  const worktreePathEnd = indexAfterSegments(
    normalizedCwd,
    normalizedRoot.length,
    relativeSegments.slice(0, 2),
  );

  return {
    worktreePath: cwd.slice(0, worktreePathEnd),
    projectWorktreesRoot: cwd.slice(0, projectWorktreesRootEnd),
    mainRepoRoot: null,
  };
}

/** Walks past `segments` starting at `offset`, tolerating repeated separators. */
function indexAfterSegments(normalizedPath: string, offset: number, segments: string[]): number {
  let index = offset;
  for (const segment of segments) {
    while (normalizedPath[index] === "/") {
      index += 1;
    }
    index += segment.length;
  }
  return index;
}

// COMPAT(worktreesRoot): added in v0.3.0, remove after 2027-08-04 once the daemon
// floor reports `server_info.worktreesRoot`. Older daemons kept worktrees under a
// `.paseo/worktrees` directory next to the repo, which is why the parent repo was
// readable straight off the path.
function matchLegacyMarker(cwd: string): PaseoWorktreePlacement | null {
  const normalizedCwd = toForwardSlashes(cwd);
  const markerIndex = findMarkerIndex(normalizedCwd);
  if (markerIndex < 0) {
    return null;
  }

  const markerEnd = markerIndex + LEGACY_WORKTREE_MARKER.length;
  const afterMarker = normalizedCwd[markerEnd];
  if (afterMarker !== undefined && afterMarker !== "/") {
    return null;
  }

  const slug = firstSegment(normalizedCwd.slice(markerEnd));
  const projectWorktreesRoot = cwd.slice(0, markerEnd);
  return {
    worktreePath: slug
      ? cwd.slice(0, indexAfterSegments(normalizedCwd, markerEnd, [slug]))
      : projectWorktreesRoot,
    projectWorktreesRoot,
    mainRepoRoot: cwd.slice(0, markerIndex).replace(/[\\/]+$/, "") || null,
  };
}

/** Index of the marker when it starts a path segment, otherwise -1. */
function findMarkerIndex(normalizedPath: string): number {
  if (normalizedPath.startsWith(LEGACY_WORKTREE_MARKER)) {
    return 0;
  }
  const index = normalizedPath.indexOf(`/${LEGACY_WORKTREE_MARKER}`);
  return index < 0 ? -1 : index + 1;
}

function firstSegment(value: string): string | undefined {
  return value.split("/").find((segment) => segment.length > 0);
}
