import type { PluginNavigation, PluginOpenWorkspaceOptions } from "@getpaseo/plugin";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { openExternalUrl } from "@/utils/open-external-url";

export interface PluginNavigationDeps {
  navigateToWorkspace: typeof navigateToWorkspace;
  navigateToAgent: typeof navigateToAgent;
  openExternalUrl: typeof openExternalUrl;
}

const defaultDeps: PluginNavigationDeps = { navigateToWorkspace, navigateToAgent, openExternalUrl };

const EXTERNAL_URL_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Host-owned navigation handed to plugin surfaces, panels, and Command Center
 * callbacks. Plugin code addresses workspaces by ID only; route shapes, tab
 * preparation, and pinning stay here.
 */
export function createPluginNavigation(
  serverId: string,
  deps: PluginNavigationDeps = defaultDeps,
): PluginNavigation {
  return {
    openWorkspace(workspaceId: string, options?: PluginOpenWorkspaceOptions) {
      const targetWorkspaceId = workspaceId.trim();
      if (!targetWorkspaceId) throw new Error("openWorkspace requires a workspace id");
      const targetServerId = options?.serverId?.trim() || serverId;
      const agentId = options?.agentId?.trim();
      if (agentId) {
        deps.navigateToAgent({
          serverId: targetServerId,
          agentId,
          workspaceId: targetWorkspaceId,
          pin: options?.pin ?? true,
        });
        return;
      }
      deps.navigateToWorkspace({
        serverId: targetServerId,
        workspaceId: targetWorkspaceId,
        ...(options?.pin === undefined ? {} : { pin: options.pin }),
      });
    },
    async openExternal(url: string) {
      // openExternalUrl silently drops anything it will not open. A plugin
      // handing over a bad URL should hear about it instead of watching
      // nothing happen.
      let protocol: string;
      try {
        protocol = new URL(url).protocol;
      } catch {
        throw new Error(`openExternal requires an absolute URL: ${url}`);
      }
      if (!EXTERNAL_URL_PROTOCOLS.has(protocol)) {
        throw new Error(`openExternal only opens http(s) URLs: ${url}`);
      }
      await deps.openExternalUrl(url);
    },
  };
}
