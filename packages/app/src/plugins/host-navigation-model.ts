import type { PluginPendingAgentMessage, PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { NavigateToWorkspaceInput } from "@/stores/navigation-active-workspace-store";
import { parseServerIdFromPathname } from "@/utils/host-routes";
import { isHttpUrl } from "@/utils/http-url";

interface HostNavigationOwner {
  browserAvailable: boolean;
  isHostRegistered(serverId: string): boolean;
  openAgent(input: {
    serverId: string;
    agentId: string;
    pendingMessage?: PluginPendingAgentMessage;
  }): string;
  withdrawPendingAgentMessage(input: {
    serverId: string;
    agentId: string;
    clientMessageId: string;
  }): void;
  openWorkspace(input: NavigateToWorkspaceInput): string;
  resolveWorkspace(input: { serverId: string; workspaceId: string }): string | null;
  createBrowser(input: { initialUrl: string }): { browserId: string };
  focusHost(serverId: string): void;
  /** Whether the navigating plugin currently registers this surface. */
  hasSurface(surfaceId: string): boolean;
  openSurface(surfaceId: string): void;
}

export function createPluginHostNavigation(
  serverId: string,
  owner: HostNavigationOwner,
): NonNullable<PluginSurfaceProps["navigation"]> {
  const focusRouteHost = (route: string) => {
    const destinationServerId = parseServerIdFromPathname(route);
    if (destinationServerId && owner.isHostRegistered(destinationServerId)) {
      owner.focusHost(destinationServerId);
    }
  };

  return {
    supportsFocusHost: true,
    openAgent: ({ agentId, serverId: targetServerId, pendingMessage, focusHost }) => {
      const route = owner.openAgent({
        serverId: targetServerId ?? serverId,
        agentId,
        ...(pendingMessage ? { pendingMessage } : {}),
      });
      if (focusHost) focusRouteHost(route);
    },
    withdrawPendingAgentMessage: ({ agentId, clientMessageId, serverId: targetServerId }) =>
      owner.withdrawPendingAgentMessage({
        serverId: targetServerId ?? serverId,
        agentId,
        clientMessageId,
      }),
    openWorkspace: ({ workspaceId, serverId: targetServerId, focusHost }) => {
      const route = owner.openWorkspace({ serverId: targetServerId ?? serverId, workspaceId });
      if (focusHost) focusRouteHost(route);
    },
    openSurface: (id) => {
      const surfaceId = id.trim();
      if (!owner.hasSurface(surfaceId)) throw new Error(`Plugin surface is unavailable: ${id}`);
      owner.openSurface(surfaceId);
    },
    openBrowser: owner.browserAvailable
      ? ({ url, workspaceId, serverId: targetServerId }) => {
          if (!isHttpUrl(url)) throw new Error("Only absolute HTTP(S) URLs are supported.");
          if (!workspaceId.trim()) throw new Error("workspaceId is required.");
          const destinationServerId = targetServerId ?? serverId;
          const destinationWorkspaceId = owner.resolveWorkspace({
            serverId: destinationServerId,
            workspaceId,
          });
          if (!destinationWorkspaceId)
            throw new Error("Workspace is unavailable on the requested host.");
          const { browserId } = owner.createBrowser({ initialUrl: url });
          owner.openWorkspace({
            serverId: destinationServerId,
            workspaceId: destinationWorkspaceId,
            target: { kind: "browser", browserId },
          });
        }
      : undefined,
  };
}
