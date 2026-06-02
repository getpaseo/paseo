import type { Logger } from "pino";
import { buildPublicScriptHostname, buildScriptHostname } from "../utils/script-hostname.js";
import type { ScriptRouteEntry, ScriptRouteStore } from "./script-proxy.js";

interface BranchChangeRouteHandlerOptions {
  routeStore: ScriptRouteStore;
  onRoutesChanged: (workspaceId: string) => void;
  logger?: Logger;
}

interface RouteHostnameUpdate {
  oldHostname: string;
  newHostname: string;
  newPublicHostname: string | null;
  route: ScriptRouteEntry;
}

export function createBranchChangeRouteHandler(
  options: BranchChangeRouteHandlerOptions,
): (workspaceId: string, oldBranch: string | null, newBranch: string | null) => void {
  return (workspaceId, _oldBranch, newBranch) => {
    // Only service scripts register routes, so branch renames only touch services.
    const routes = options.routeStore.listRoutesForWorkspace(workspaceId);
    if (routes.length === 0) {
      return;
    }

    const updates: RouteHostnameUpdate[] = [];
    for (const route of routes) {
      const newHostname = buildScriptHostname({
        projectSlug: route.projectSlug,
        branchName: newBranch,
        scriptName: route.scriptName,
      });
      const newPublicHostname = route.publicBaseUrl
        ? buildPublicScriptHostname({
            projectSlug: route.projectSlug,
            branchName: newBranch,
            scriptName: route.scriptName,
            publicBaseUrl: route.publicBaseUrl,
          })
        : null;
      if (newHostname !== route.hostname || newPublicHostname !== (route.publicHostname ?? null)) {
        updates.push({
          oldHostname: route.hostname,
          newHostname,
          newPublicHostname,
          route,
        });
      }
    }

    if (updates.length === 0) {
      return;
    }

    for (const { oldHostname, newHostname, newPublicHostname, route } of updates) {
      options.routeStore.removeRoute(oldHostname);
      options.routeStore.registerRoute({
        hostname: newHostname,
        publicHostname: newPublicHostname,
        publicBaseUrl: route.publicBaseUrl ?? null,
        port: route.port,
        workspaceId: route.workspaceId,
        projectSlug: route.projectSlug,
        scriptName: route.scriptName,
      });
      options.logger?.info(
        {
          oldHostname,
          newHostname,
          scriptName: route.scriptName,
        },
        "Updated script route for branch rename",
      );
    }

    options.onRoutesChanged(workspaceId);
  };
}
