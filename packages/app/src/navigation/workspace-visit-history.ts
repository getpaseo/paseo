import type { ActiveWorkspaceSelection } from "@/stores/last-workspace-selection";

export interface WorkspaceVisit extends ActiveWorkspaceSelection {
  tabId: string | null;
}

export type WorkspaceVisitDirection = -1 | 1;

interface WorkspaceVisitReplay {
  visit: WorkspaceVisit;
  navigateWorkspace: boolean;
}

const MAX_VISITS = 100;

function sameWorkspace(a: ActiveWorkspaceSelection | undefined, b: ActiveWorkspaceSelection) {
  return a?.serverId === b.serverId && a.workspaceId === b.workspaceId;
}

function sameVisit(a: WorkspaceVisit | undefined, b: WorkspaceVisit) {
  return sameWorkspace(a, b) && a?.tabId === b.tabId;
}

export function createWorkspaceVisitHistory() {
  const visits: WorkspaceVisit[] = [];
  let cursor = -1;
  let observed: WorkspaceVisit | undefined;
  // A shortcut can move the cursor before the route and tab selection commit.
  const pendingVisits: WorkspaceVisit[] = [];

  return {
    record(visit: WorkspaceVisit) {
      if (sameVisit(visits[cursor], visit)) {
        observed = visit;
        pendingVisits.length = 0;
        return;
      }
      if (pendingVisits.some((pending) => sameVisit(pending, visit))) return;
      if (sameVisit(observed, visit)) return;

      observed = visit;
      pendingVisits.length = 0;
      visits.splice(cursor + 1, visits.length, visit);
      if (visits.length > MAX_VISITS) visits.shift();
      cursor = visits.length - 1;
    },

    move(
      direction: WorkspaceVisitDirection,
      activeWorkspace: ActiveWorkspaceSelection | null,
      canRestore: (visit: WorkspaceVisit) => boolean,
    ): WorkspaceVisitReplay | null {
      const current = visits[cursor];
      if (!current) return null;

      const returningToWorkspace = direction === -1 && !activeWorkspace && !pendingVisits.length;
      const start = returningToWorkspace ? cursor : cursor + direction;
      for (let index = start; index >= 0 && index < visits.length; index += direction) {
        const visit = visits[index];
        if ((!returningToWorkspace && sameVisit(current, visit)) || !canRestore(visit)) continue;

        const routeInFlight = pendingVisits.length > 0 && !sameWorkspace(current, visit);
        if (!pendingVisits.some((pending) => sameVisit(pending, current))) {
          pendingVisits.push(current);
        }
        cursor = index;
        return {
          visit,
          navigateWorkspace: routeInFlight || !sameWorkspace(activeWorkspace ?? undefined, visit),
        };
      }
      return null;
    },
  };
}

export const workspaceVisitHistory = createWorkspaceVisitHistory();
