import type { ActiveWorkspaceSelection } from "@/stores/last-workspace-selection";
import type { buildPluginSurfaceRoute } from "@/plugins/routes";
import type { PluginSurfaceContributionIdentity } from "@/plugins/surface-contribution";

export interface WorkspaceVisit extends ActiveWorkspaceSelection {
  kind: "workspace";
  tabId: string | null;
}

interface PluginScreenRoute {
  serverId: string;
  pluginId: string;
  identity: PluginSurfaceContributionIdentity;
}

interface PluginScreenVisit extends PluginScreenRoute {
  kind: "plugin";
  href: ReturnType<typeof buildPluginSurfaceRoute>;
}

export type AppVisit = WorkspaceVisit | PluginScreenVisit;
export type AppVisitDirection = -1 | 1;
type ActiveVisitRoute = ActiveWorkspaceSelection | PluginScreenRoute | null;

const MAX_VISITS = 100;

function sameWorkspace(a: ActiveWorkspaceSelection | undefined, b: ActiveWorkspaceSelection) {
  return a?.serverId === b.serverId && a.workspaceId === b.workspaceId;
}

function visitMatchesActiveRoute(visit: AppVisit | undefined, route: ActiveVisitRoute): boolean {
  if (!visit || !route) return false;
  if (visit.kind === "workspace") return "workspaceId" in route && sameWorkspace(route, visit);
  return (
    "pluginId" in route &&
    route.serverId === visit.serverId &&
    route.pluginId === visit.pluginId &&
    route.identity.kind === visit.identity.kind &&
    route.identity.id === visit.identity.id
  );
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

      const onObservedRoute = visitMatchesActiveRoute(observed, activeRoute);
      const returningFromDetour = direction === -1 && !onObservedRoute && !pendingVisits.length;
      const start = returningFromDetour ? cursor : cursor + direction;
      for (let index = start; index >= 0 && index < visits.length; index += direction) {
        const visit = visits[index];
        if ((!returningFromDetour && sameVisit(current, visit)) || !canRestore(visit)) continue;

        const routeInFlight = pendingVisits.length > 0 && !sameVisitRoute(current, visit);
        if (onObservedRoute && sameVisit(observed, visit)) {
          // A coalesced round trip can end on the already-observed visit without a new commit.
          pendingVisits.length = 0;
        } else if (!pendingVisits.some((pending) => sameVisit(pending, current))) {
          pendingVisits.push(current);
        }
        cursor = index;
        const sameActiveWorkspace =
          visit.kind === "workspace" && visitMatchesActiveRoute(visit, activeRoute);
        return { visit, navigateRoute: routeInFlight || !sameActiveWorkspace };
      }
      return null;
    },
  };
}

export const appVisitHistory = createAppVisitHistory();
