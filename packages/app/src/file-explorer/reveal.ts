import type { ExplorerDirectory } from "@/stores/session-store";
import { resolveWorkspaceFilePaths } from "@/workspace/file-open";
import type { ExplorerListRow } from "./tree";
import { isHiddenExplorerPath } from "./visibility";

export interface ExplorerRevealRequest {
  /** Workspace-relative tree path. */
  path: string;
  requestId: number;
  /** `Date.now()` when the user asked. */
  createdAt: number;
}

/**
 * Backstop for a request no visible tree picks up. It covers a slow relay listing of the
 * workspace root and its restored folders with room to spare; past it the user has moved on, and finishing would move the
 * tree on its own.
 */
export const EXPLORER_REVEAL_REQUEST_TTL_MS = 15_000;

export type ExplorerRevealRequests = Readonly<Record<string, ExplorerRevealRequest>>;

export interface ExplorerRevealPlan {
  path: string;
  /** Directories to expand, root first. Stops before the first hidden segment. */
  ancestors: string[];
  /** Row to select and scroll to, or null when no row of the path is visible. */
  selectPath: string | null;
  isHidden: boolean;
}

export type ExplorerRevealOutcome =
  | "revealed"
  | "hidden"
  | "not-found"
  | "listing-failed"
  | "superseded";

interface RunExplorerRevealInput {
  plan: ExplorerRevealPlan;
  getDirectory: (path: string) => ExplorerDirectory | undefined;
  requestDirectoryListing: (path: string) => Promise<ExplorerDirectory | null>;
  expandDirectory: (path: string) => void;
  isCurrent: () => boolean;
}

export function buildExplorerRevealKey(input: {
  serverId: string;
  workspaceStateKey: string;
}): string {
  return `${input.serverId}\u0000${input.workspaceStateKey}`;
}

/** Converts a file tab path to the tree's workspace-relative form; null outside the workspace. */
export function resolveExplorerRevealPath(input: {
  path: string;
  workspaceRoot: string;
}): string | null {
  return resolveWorkspaceFilePaths(input)?.relativePath ?? null;
}

export function isExplorerRevealRequestExpired(
  request: ExplorerRevealRequest,
  now: number,
): boolean {
  return now - request.createdAt > EXPLORER_REVEAL_REQUEST_TTL_MS;
}

/**
 * Reports when the tree's restore of persisted expanded folders is over, so a reveal waiting on
 * it can start. `restore` resolves to the restored workspace key, or null when that call restored
 * nothing and a later run retries. A restore that throws is over too: it reports `attemptKey`
 * and rethrows, so a waiting reveal never sits out its TTL. A result from an attempt that is no
 * longer the tree's newest is dropped, even for the same workspace: after A -> B -> A the first
 * A restore can land while the second is still running.
 */
export async function settleExplorerTreeRestore(input: {
  restore: Promise<string | null>;
  attemptKey: string | null;
  isCurrentAttempt: () => boolean;
  onSettled: (key: string) => void;
}): Promise<void> {
  const settle = (key: string | null) => {
    if (key && input.isCurrentAttempt()) {
      input.onSettled(key);
    }
  };
  try {
    settle(await input.restore);
  } catch (error) {
    settle(input.attemptKey);
    throw error;
  }
}

export function explorerAncestorPaths(path: string): string[] {
  const segments = path.split("/").slice(0, -1);
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
}

export function planExplorerReveal(input: {
  path: string;
  showHiddenFiles: boolean;
}): ExplorerRevealPlan {
  const ancestors = explorerAncestorPaths(input.path);
  const isHidden = !input.showHiddenFiles && isHiddenExplorerPath(input.path);
  if (!isHidden) {
    return { path: input.path, ancestors, selectPath: input.path, isHidden };
  }
  const firstHiddenIndex = ancestors.findIndex(isHiddenExplorerPath);
  const visibleAncestors =
    firstHiddenIndex === -1 ? ancestors : ancestors.slice(0, firstHiddenIndex);
  return {
    path: input.path,
    ancestors: visibleAncestors,
    selectPath: visibleAncestors.at(-1) ?? null,
    isHidden,
  };
}

export function findExplorerListRowIndex(rows: readonly ExplorerListRow[], path: string): number {
  return rows.findIndex((row) => {
    if (row.type === "entry") return row.row.entry.path === path;
    if (row.type === "rename") return row.entry.path === path;
    return false;
  });
}

export function replaceExplorerRevealRequest(
  requests: ExplorerRevealRequests,
  key: string,
  request: ExplorerRevealRequest,
): ExplorerRevealRequests {
  return { ...requests, [key]: request };
}

/** Clears a finished request unless a newer one already replaced it. */
export function clearExplorerRevealRequest(
  requests: ExplorerRevealRequests,
  key: string,
  requestId: number,
): ExplorerRevealRequests {
  if (requests[key]?.requestId !== requestId) {
    return requests;
  }
  const { [key]: _finished, ...rest } = requests;
  return rest;
}

function containsEntry(
  directory: ExplorerDirectory,
  path: string,
  kind: "file" | "directory",
): boolean {
  return directory.entries.some((entry) => entry.path === path && entry.kind === kind);
}

interface ListedDirectory {
  directory: ExplorerDirectory;
  /** Listed during this reveal, so a missing entry is really missing. */
  isFresh: boolean;
}

type EntryLookup = { parent: ListedDirectory } | { outcome: ExplorerRevealOutcome };

/**
 * Listings are cached until the user refreshes, so an agent can create a file after its folder
 * was listed. A cached parent that lacks the entry is re-listed once before it counts as missing.
 */
async function findEntryInParent(
  input: RunExplorerRevealInput,
  parent: ListedDirectory,
  entry: { path: string; kind: "file" | "directory" },
): Promise<EntryLookup> {
  if (containsEntry(parent.directory, entry.path, entry.kind)) {
    return { parent };
  }
  if (parent.isFresh) {
    return { outcome: "not-found" };
  }
  const relisted = await input.requestDirectoryListing(parent.directory.path);
  if (!input.isCurrent()) {
    return { outcome: "superseded" };
  }
  if (!relisted) {
    return { outcome: "listing-failed" };
  }
  if (!containsEntry(relisted, entry.path, entry.kind)) {
    return { outcome: "not-found" };
  }
  return { parent: { directory: relisted, isFresh: true } };
}

/**
 * Expands the plan's ancestors root first, listing each uncached directory before descending.
 * Each ancestor is checked against its parent listing so a stale tab never lists a missing path.
 */
export async function runExplorerReveal(
  input: RunExplorerRevealInput,
): Promise<ExplorerRevealOutcome> {
  const { plan } = input;
  const root = input.getDirectory(".");
  if (!root) {
    return "listing-failed";
  }
  let parent: ListedDirectory = { directory: root, isFresh: false };
  for (const ancestor of plan.ancestors) {
    const lookup = await findEntryInParent(input, parent, { path: ancestor, kind: "directory" });
    if ("outcome" in lookup) {
      return lookup.outcome;
    }
    input.expandDirectory(ancestor);
    const cached = input.getDirectory(ancestor);
    const listed = cached ?? (await input.requestDirectoryListing(ancestor));
    if (!input.isCurrent()) {
      return "superseded";
    }
    if (!listed) {
      return "listing-failed";
    }
    parent = { directory: listed, isFresh: !cached };
  }
  if (plan.isHidden) {
    return "hidden";
  }
  const lookup = await findEntryInParent(input, parent, { path: plan.path, kind: "file" });
  return "outcome" in lookup ? lookup.outcome : "revealed";
}
