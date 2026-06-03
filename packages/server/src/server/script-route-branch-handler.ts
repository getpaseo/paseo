import type { Logger } from "pino";
import type { ServiceProxySubsystem } from "./service-proxy.js";

interface BranchChangeRouteHandlerOptions {
  serviceProxy: ServiceProxySubsystem;
  onRoutesChanged: (workspaceId: string) => void;
  logger?: Logger;
}

export function createBranchChangeRouteHandler(
  options: BranchChangeRouteHandlerOptions,
): (workspaceId: string, oldBranch: string | null, newBranch: string | null) => void {
  return (workspaceId, _oldBranch, newBranch) => {
    const changed = options.serviceProxy.replaceWorkspaceBranchRoutes({ workspaceId, newBranch });
    if (!changed) {
      return;
    }
    options.logger?.info(
      { workspaceId, newBranch },
      "Updated service proxy routes for branch rename",
    );
    options.onRoutesChanged(workspaceId);
  };
}
