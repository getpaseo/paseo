import type { ActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";

export const WORKSPACE_DECK_MAX_MOUNTED_WORKSPACES = 10;
export const WORKSPACE_DECK_INACTIVE_TTL_MS = 10 * 60 * 1000;

export interface RetainedWorkspaceSelection {
  selection: ActiveWorkspaceSelection;
  inactiveSince: number | null;
}

export function resolveWorkspaceDeckRetentionLimit(input: { isNative: boolean }): number {
  return input.isNative ? 1 : WORKSPACE_DECK_MAX_MOUNTED_WORKSPACES;
}

interface ReconcileRetainedWorkspaceSelectionsInput {
  currentEntries: RetainedWorkspaceSelection[];
  activeSelection: ActiveWorkspaceSelection | null;
  now: number;
  maxMountedWorkspaces?: number;
  inactiveTtlMs?: number;
}

interface GetNextWorkspaceDeckExpirationDelayInput {
  entries: RetainedWorkspaceSelection[];
  activeSelection: ActiveWorkspaceSelection | null;
  now: number;
  inactiveTtlMs?: number;
}

interface WorkspaceDeckEntryMountInput {
  isActive: boolean;
  hasHydratedWorkspaces: boolean;
  workspaceExists: boolean;
}

interface ResolveWorkspaceDeckEntriesInput {
  selections: ActiveWorkspaceSelection[];
  activeSelection: ActiveWorkspaceSelection | null;
}

export function getWorkspaceSelectionKey(selection: ActiveWorkspaceSelection): string {
  return `${selection.serverId}:${selection.workspaceId}`;
}

export function areWorkspaceSelectionsEqual(
  left: ActiveWorkspaceSelection | null,
  right: ActiveWorkspaceSelection | null,
): boolean {
  return left?.serverId === right?.serverId && left?.workspaceId === right?.workspaceId;
}

export function areRetainedWorkspaceSelectionListsEqual(
  left: RetainedWorkspaceSelection[],
  right: RetainedWorkspaceSelection[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((entry, index) => {
    const otherEntry = right[index];
    return (
      otherEntry !== undefined &&
      entry.inactiveSince === otherEntry.inactiveSince &&
      areWorkspaceSelectionsEqual(entry.selection, otherEntry.selection)
    );
  });
}

export function reconcileRetainedWorkspaceSelections({
  currentEntries,
  activeSelection,
  now,
  maxMountedWorkspaces = WORKSPACE_DECK_MAX_MOUNTED_WORKSPACES,
  inactiveTtlMs = WORKSPACE_DECK_INACTIVE_TTL_MS,
}: ReconcileRetainedWorkspaceSelectionsInput): RetainedWorkspaceSelection[] {
  const maxSelections = activeSelection
    ? Math.max(1, maxMountedWorkspaces)
    : Math.max(0, maxMountedWorkspaces);
  const nextEntries: RetainedWorkspaceSelection[] = [];
  const seenSelectionKeys = new Set<string>();

  function appendEntry(entry: RetainedWorkspaceSelection): void {
    if (nextEntries.length >= maxSelections) {
      return;
    }
    const selectionKey = getWorkspaceSelectionKey(entry.selection);
    if (seenSelectionKeys.has(selectionKey)) {
      return;
    }
    seenSelectionKeys.add(selectionKey);
    nextEntries.push(entry);
  }

  if (activeSelection) {
    appendEntry({ selection: activeSelection, inactiveSince: null });
  }

  for (const entry of currentEntries) {
    if (areWorkspaceSelectionsEqual(entry.selection, activeSelection)) {
      continue;
    }
    const inactiveSince = entry.inactiveSince ?? now;
    if (now - inactiveSince >= inactiveTtlMs) {
      continue;
    }
    appendEntry({ selection: entry.selection, inactiveSince });
  }

  if (areRetainedWorkspaceSelectionListsEqual(currentEntries, nextEntries)) {
    return currentEntries;
  }
  return nextEntries;
}

export function getNextWorkspaceDeckExpirationDelay({
  entries,
  activeSelection,
  now,
  inactiveTtlMs = WORKSPACE_DECK_INACTIVE_TTL_MS,
}: GetNextWorkspaceDeckExpirationDelayInput): number | null {
  let nextExpirationDelay: number | null = null;

  for (const entry of entries) {
    if (
      areWorkspaceSelectionsEqual(entry.selection, activeSelection) ||
      entry.inactiveSince === null
    ) {
      continue;
    }
    const expirationDelay = Math.max(0, entry.inactiveSince + inactiveTtlMs - now);
    nextExpirationDelay =
      nextExpirationDelay === null
        ? expirationDelay
        : Math.min(nextExpirationDelay, expirationDelay);
  }

  return nextExpirationDelay;
}

export function orderWorkspaceSelectionsForStableRender(
  selections: ActiveWorkspaceSelection[],
): ActiveWorkspaceSelection[] {
  return [...selections].sort((left, right) =>
    getWorkspaceSelectionKey(left).localeCompare(getWorkspaceSelectionKey(right)),
  );
}

export function resolveWorkspaceDeckEntries({
  selections,
  activeSelection,
}: ResolveWorkspaceDeckEntriesInput): Array<{
  selection: ActiveWorkspaceSelection;
  active: boolean;
}> {
  return selections.map((selection) => ({
    selection,
    active: areWorkspaceSelectionsEqual(selection, activeSelection),
  }));
}

export function shouldKeepWorkspaceDeckEntryMounted({
  isActive,
  hasHydratedWorkspaces,
  workspaceExists,
}: WorkspaceDeckEntryMountInput): boolean {
  if (isActive) {
    return true;
  }
  if (!hasHydratedWorkspaces) {
    return true;
  }
  return workspaceExists;
}
