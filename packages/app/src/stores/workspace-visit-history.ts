import type { ActiveWorkspaceSelection } from "@/stores/last-workspace-selection";

export type WorkspaceAvailability = (selection: ActiveWorkspaceSelection) => boolean;

const DEFAULT_LIMIT = 50;

function isSameSelection(
  a: ActiveWorkspaceSelection | null | undefined,
  b: ActiveWorkspaceSelection | null | undefined,
): boolean {
  return !!a && !!b && a.serverId === b.serverId && a.workspaceId === b.workspaceId;
}

// Session-only visit history: a back/forward stack plus a most-recently-used list.
// Startup restore stays with the last-workspace selection store.
export function createWorkspaceVisitHistory(options: { limit?: number } = {}) {
  const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
  let entries: ActiveWorkspaceSelection[] = [];
  let cursor = -1;
  let mru: ActiveWorkspaceSelection[] = [];
  // Target of an in-flight back/forward step; its landing must not push a new entry.
  let pending: ActiveWorkspaceSelection | null = null;

  function touchMru(selection: ActiveWorkspaceSelection) {
    mru = [selection, ...mru.filter((entry) => !isSameSelection(entry, selection))].slice(0, limit);
  }

  function record(next: ActiveWorkspaceSelection) {
    const selection = { serverId: next.serverId, workspaceId: next.workspaceId };
    touchMru(selection);
    if (pending) {
      const landed = isSameSelection(pending, selection);
      pending = null;
      if (landed) {
        return;
      }
    }
    if (isSameSelection(entries[cursor], selection)) {
      return;
    }
    entries = [...entries.slice(0, cursor + 1), selection];
    if (entries.length > limit) {
      entries = entries.slice(entries.length - limit);
    }
    cursor = entries.length - 1;
  }

  function findStepIndex(delta: 1 | -1, isAvailable: WorkspaceAvailability): number {
    const current = entries[cursor];
    for (let index = cursor + delta; index >= 0 && index < entries.length; index += delta) {
      const entry = entries[index];
      if (entry && !isSameSelection(entry, current) && isAvailable(entry)) {
        return index;
      }
    }
    return -1;
  }

  function step(
    delta: 1 | -1,
    isAvailable: WorkspaceAvailability,
  ): ActiveWorkspaceSelection | null {
    const index = findStepIndex(delta, isAvailable);
    const target = entries[index];
    if (index < 0 || !target) {
      return null;
    }
    cursor = index;
    pending = target;
    return target;
  }

  function previous(isAvailable: WorkspaceAvailability): ActiveWorkspaceSelection | null {
    return mru.slice(1).find(isAvailable) ?? null;
  }

  return {
    record,
    step,
    canStep: (delta: 1 | -1, isAvailable: WorkspaceAvailability) =>
      findStepIndex(delta, isAvailable) >= 0,
    previous,
  };
}
