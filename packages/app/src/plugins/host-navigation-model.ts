import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { NavigateToWorkspaceInput } from "@/stores/navigation-active-workspace-store";
import { isHttpUrl } from "@/utils/http-url";

interface HostNavigationOwner {
  browserAvailable: boolean;
  openAgent(input: { serverId: string; agentId: string }): void;
  openWorkspace(input: NavigateToWorkspaceInput): void;
  resolveWorkspace(input: { serverId: string; workspaceId: string }): string | null;
  createBrowser(input: { initialUrl: string }): { browserId: string };
  focusHost(serverId: string): void;
}

export function createPluginHostNavigation(
  serverId: string,
  owner: HostNavigationOwner,
): NonNullable<PluginSurfaceProps["navigation"]> {
  return {
    supportsFocusHost: true,
    openAgent: ({ agentId, serverId: targetServerId, focusHost }) => {
      const destinationServerId = targetServerId ?? serverId;
      owner.openAgent({ serverId: destinationServerId, agentId });
      if (focusHost) owner.focusHost(destinationServerId);
    },
    openWorkspace: ({ workspaceId, serverId: targetServerId, focusHost }) => {
      const destinationServerId = targetServerId ?? serverId;
      owner.openWorkspace({ serverId: destinationServerId, workspaceId });
      if (focusHost) owner.focusHost(destinationServerId);
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
