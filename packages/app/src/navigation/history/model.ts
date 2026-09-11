import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import {
  parseActiveWorkspaceSelection,
  type RouteSelectionInput,
} from "@/stores/navigation-active-workspace-store/navigation";

/**
 * One place the user was looking at. Workspace entries carry the focused tab so back/forward
 * steps through tabs as well as workspaces. `target` is payload for re-opening a closed tab,
 * never identity: only `tabId` decides whether two entries are the same place.
 */
export type HistoryEntry =
  | {
      kind: "workspace";
      serverId: string;
      workspaceId: string;
      tabId: string | null;
      target: WorkspaceTabTarget | null;
    }
  | { kind: "route"; path: string };

export interface HistoryState {
  entries: readonly HistoryEntry[];
  index: number;
}

export const EMPTY_HISTORY_STATE: HistoryState = { entries: [], index: -1 };

export const HISTORY_ENTRY_CAP = 100;

export function entriesEqual(a: HistoryEntry, b: HistoryEntry): boolean {
  if (a.kind === "route") {
    return b.kind === "route" && a.path === b.path;
  }
  if (b.kind === "route") {
    return false;
  }
  return a.serverId === b.serverId && a.workspaceId === b.workspaceId && a.tabId === b.tabId;
}

/** Appends a visited location: no-op on the current entry, drops the forward branch, caps size. */
export function pushEntry(state: HistoryState, entry: HistoryEntry): HistoryState {
  const current = state.entries[state.index];
  if (current && entriesEqual(current, entry)) {
    return state;
  }
  const kept = state.entries.slice(0, state.index + 1);
  kept.push(entry);
  const overflow = Math.max(0, kept.length - HISTORY_ENTRY_CAP);
  const entries = overflow > 0 ? kept.slice(overflow) : kept;
  return { entries, index: entries.length - 1 };
}

export function replaceEntryAt(
  state: HistoryState,
  index: number,
  entry: HistoryEntry,
): HistoryState {
  if (index < 0 || index >= state.entries.length) {
    return state;
  }
  const entries = state.entries.slice();
  entries[index] = entry;
  return { entries, index: state.index };
}

/** Next index in `delta` direction whose entry is still alive, or null at the end of the stack. */
export function stepIndex(
  state: HistoryState,
  delta: 1 | -1,
  isAlive: (entry: HistoryEntry) => boolean,
): number | null {
  for (
    let index = state.index + delta;
    index >= 0 && index < state.entries.length;
    index += delta
  ) {
    const entry = state.entries[index];
    if (entry && isAlive(entry)) {
      return index;
    }
  }
  return null;
}

// Routes that only exist to redirect somewhere else. Recording them would leave a dead entry in
// front of every real destination. A deny-list rather than an allow-list so new resting routes
// are recorded without anyone remembering this file.
const TRANSIENT_EXACT_PATHS = new Set(["", "/", "/welcome", "/pair-scan", "/settings"]);
const TRANSIENT_PATH_PATTERNS: readonly RegExp[] = [
  /^\/settings\/hosts\/[^/]+$/,
  /^\/h\/[^/]+$/,
  /^\/h\/[^/]+\/(agent|sessions|settings|open-project)(\/|$)/,
  // The three-segment plugin URL is the legacy redirect. Current plugin surfaces add both a
  // contribution kind and id, so those remain resting routes and belong in app history.
  /^\/h\/[^/]+\/plugin\/[^/]+\/[^/]+$/,
];

function normalizePathname(pathname: string): string {
  const withoutSearch = pathname.split(/[?#]/, 1)[0] ?? "";
  if (withoutSearch.length > 1 && withoutSearch.endsWith("/")) {
    return withoutSearch.slice(0, -1);
  }
  return withoutSearch;
}

export function isTransientPathname(pathname: string): boolean {
  const normalized = normalizePathname(pathname);
  if (TRANSIENT_EXACT_PATHS.has(normalized)) {
    return true;
  }
  return TRANSIENT_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Turns the current route into a history entry, or null for routes that are not a resting place.
 * Workspace entries come back with no tab; the recorder fills that in from the layout store.
 */
export function classifyLocation(input: RouteSelectionInput): HistoryEntry | null {
  const selection = parseActiveWorkspaceSelection(input);
  if (selection) {
    return { kind: "workspace", ...selection, tabId: null, target: null };
  }
  if (isTransientPathname(input.pathname)) {
    return null;
  }
  return { kind: "route", path: normalizePathname(input.pathname) };
}

export type WorkspaceReplayPlan =
  | { kind: "focus"; tabId: string }
  | { kind: "reopen"; target: WorkspaceTabTarget }
  | { kind: "workspace-only" }
  | { kind: "dead" };

export interface WorkspaceReplayContext {
  workspaceExists: boolean;
  tabExists: boolean;
  agentExists: (agentId: string) => boolean;
}

// Targets whose tab can be recreated from the target alone once it has been closed. Anything
// backed by a live resource (terminal, browser, draft, subagent) or that is intentionally
// ephemeral (commit_diff, setup, new_tab) is left for dead instead of resurrecting a shell.
function isReopenableTarget(target: WorkspaceTabTarget, ctx: WorkspaceReplayContext): boolean {
  switch (target.kind) {
    case "file":
    case "files":
    case "changes_tree":
    case "working_diff":
    case "pull_request":
    case "plugin":
      return true;
    case "agent":
      return ctx.agentExists(target.agentId);
    default:
      return false;
  }
}

export function resolveWorkspaceReplay(
  entry: Extract<HistoryEntry, { kind: "workspace" }>,
  ctx: WorkspaceReplayContext,
): WorkspaceReplayPlan {
  if (!ctx.workspaceExists) {
    return { kind: "dead" };
  }
  if (entry.tabId && ctx.tabExists) {
    return { kind: "focus", tabId: entry.tabId };
  }
  if (entry.target && isReopenableTarget(entry.target, ctx)) {
    return { kind: "reopen", target: entry.target };
  }
  if (entry.tabId === null && entry.target === null) {
    return { kind: "workspace-only" };
  }
  return { kind: "dead" };
}
