import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { NavigateToWorkspaceInput } from "@/stores/navigation-active-workspace-store";
import { isHttpUrl } from "@/utils/http-url";

interface HostNavigationOwner {
  browserAvailable: boolean;
  openAgent(input: { serverId: string; agentId: string }): void;
  openWorkspace(input: NavigateToWorkspaceInput): void;
  resolveWorkspace(input: { serverId: string; workspaceId: string }): string | null;
  resolveAgentWorkspace(input: { serverId: string; agentId: string }): string | null;
  createBrowser(input: { initialUrl: string }): { browserId: string };
}

export function createPluginHostNavigation(
  serverId: string,
  owner: HostNavigationOwner,
): NonNullable<PluginSurfaceProps["navigation"]> {
  return {
    openAgent: ({ agentId, serverId: targetServerId }) =>
      owner.openAgent({ serverId: targetServerId ?? serverId, agentId }),
    openWorkspace: ({ workspaceId, serverId: targetServerId }) =>
      owner.openWorkspace({ serverId: targetServerId ?? serverId, workspaceId }),
    openProviderSubagent: ({ parentAgentId, subagentId, serverId: targetServerId }) => {
      const destinationServerId = targetServerId ?? serverId;
      const workspaceId = owner.resolveAgentWorkspace({
        serverId: destinationServerId,
        agentId: parentAgentId,
      });
      if (!workspaceId) throw new Error("Parent agent is unavailable on the requested host.");
      owner.openWorkspace({
        serverId: destinationServerId,
        workspaceId,
        target: { kind: "provider_subagent", parentAgentId, subagentId },
      });
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
