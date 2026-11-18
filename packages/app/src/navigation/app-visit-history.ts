import type { ActiveWorkspaceSelection } from "@/stores/last-workspace-selection";
import type { buildPluginSurfaceRoute } from "@/plugins/routes";
import type { PluginSurfaceContributionIdentity } from "@/plugins/surface-contribution";

export interface WorkspaceVisit extends ActiveWorkspaceSelection {
  kind: "workspace";
  tabId: string | null;
}

interface PluginScreenVisit {
  kind: "plugin";
  serverId: string;
  pluginId: string;
  identity: PluginSurfaceContributionIdentity;
  href: ReturnType<typeof buildPluginSurfaceRoute>;
}

export type AppVisit = WorkspaceVisit | PluginScreenVisit;
export type AppVisitDirection = -1 | 1;
type ActiveVisitRoute = ActiveWorkspaceSelection | "plugin" | null;

const MAX_VISITS = 100;

function sameWorkspace(a: ActiveWorkspaceSelection | undefined, b: ActiveWorkspaceSelection) {
  return a?.serverId === b.serverId && a.workspaceId === b.workspaceId;
}

function sameVisitRoute(a: AppVisit | undefined, b: AppVisit) {
  if (b.kind === "plugin") return a?.kind === "plugin" && a.href === b.href;
  return a?.kind === "workspace" && sameWorkspace(a, b);
}

function sameVisit(a: AppVisit | undefined, b: AppVisit) {
  if (!sameVisitRoute(a, b)) return false;
  return b.kind === "plugin" || (a?.kind === "workspace" && a.tabId === b.tabId);
}

export function createAppVisitHistory() {
  const visits: AppVisit[] = [];
  let cursor = -1;
  let observed: AppVisit | undefined;
  // A shortcut can move the cursor before the route and tab selection commit.
  const pendingVisits: AppVisit[] = [];

  return {
    record(visit: AppVisit) {
      const previous = observed;
      observed = visit;
      if (sameVisit(visits[cursor], visit)) {
        pendingVisits.length = 0;
        return;
      }
      if (pendingVisits.some((pending) => sameVisit(pending, visit))) return;
      if (sameVisit(previous, visit)) return;

      pendingVisits.length = 0;
      visits.splice(cursor + 1, visits.length, visit);
      if (visits.length > MAX_VISITS) visits.shift();
      cursor = visits.length - 1;
    },

    move(
      direction: AppVisitDirection,
      activeRoute: ActiveVisitRoute,
      canRestore: (visit: AppVisit) => boolean,
    ): { visit: AppVisit; navigateRoute: boolean } | null {
      const current = visits[cursor];
      if (!current) return null;

      const returningFromDetour = direction === -1 && !activeRoute && !pendingVisits.length;
      const start = returningFromDetour ? cursor : cursor + direction;
      for (let index = start; index >= 0 && index < visits.length; index += direction) {
        const visit = visits[index];
        if ((!returningFromDetour && sameVisit(current, visit)) || !canRestore(visit)) continue;

        const routeInFlight = pendingVisits.length > 0 && !sameVisitRoute(current, visit);
        if (activeRoute && sameVisit(observed, visit)) {
          // A coalesced round trip can end on the already-observed visit without a new commit.
          pendingVisits.length = 0;
        } else if (!pendingVisits.some((pending) => sameVisit(pending, current))) {
          pendingVisits.push(current);
        }
        cursor = index;
        const inWorkspace = activeRoute && activeRoute !== "plugin";
        const sameActiveWorkspace =
          inWorkspace && visit.kind === "workspace" && sameWorkspace(activeRoute, visit);
        return { visit, navigateRoute: routeInFlight || !sameActiveWorkspace };
      }
      return null;
    },
  };
}

export const appVisitHistory = createAppVisitHistory();
