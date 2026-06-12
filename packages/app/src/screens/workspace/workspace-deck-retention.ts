import type { ActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";

export const WORKSPACE_DECK_MAX_MOUNTED_WORKSPACES = 3;

interface PruneMountedWorkspaceSelectionsInput {
  currentSelections: ActiveWorkspaceSelection[];
  activeSelection: ActiveWorkspaceSelection | null;
  maxMountedWorkspaces?: number;
}

interface WorkspaceDeckEntryMountInput {
  isActive: boolean;
  hasHydratedWorkspaces: boolean;
  workspaceExists: boolean;
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

export function areWorkspaceSelectionListsEqual(
  left: ActiveWorkspaceSelection[],
  right: ActiveWorkspaceSelection[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((selection, index) =>
    areWorkspaceSelectionsEqual(selection, right[index] ?? null),
  );
}

export function pruneMountedWorkspaceSelections({
  currentSelections,
  activeSelection,
  maxMountedWorkspaces = WORKSPACE_DECK_MAX_MOUNTED_WORKSPACES,
}: PruneMountedWorkspaceSelectionsInput): ActiveWorkspaceSelection[] {
  if (!activeSelection) {
    return [];
  }

  const maxSelections = Math.max(1, maxMountedWorkspaces);
  const nextSelections: ActiveWorkspaceSelection[] = [];
  const seenSelectionKeys = new Set<string>();

  function appendSelection(selection: ActiveWorkspaceSelection): void {
    if (nextSelections.length >= maxSelections) {
      return;
    }
    const selectionKey = getWorkspaceSelectionKey(selection);
    if (seenSelectionKeys.has(selectionKey)) {
      return;
    }
    seenSelectionKeys.add(selectionKey);
    nextSelections.push(selection);
  }

  appendSelection(activeSelection);

  for (const selection of currentSelections) {
    if (areWorkspaceSelectionsEqual(selection, activeSelection)) {
      continue;
    }
    appendSelection(selection);
  }

  return nextSelections;
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
