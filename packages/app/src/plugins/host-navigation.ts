import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSessionStore } from "@/stores/session-store";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";
import { useMemo } from "react";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { openPluginAgentLaunch } from "./agent-launch";

import { getIsElectron } from "@/constants/platform";
import { createWorkspaceBrowser } from "@/desktop/browser/store";
import { createPluginHostNavigation } from "./host-navigation-model";
import { createPluginNavigation } from "./navigation";
import { pluginOverlayStore } from "./overlays/store";
import { pluginRegistry } from "./registry";

/** Non-hook form. Header buttons and timeline items build one per plugin outside React. */
export function buildPluginHostNavigation(
  serverId: string,
  pluginId: string,
): NonNullable<PluginSurfaceProps["navigation"]> {
  return {
    ...createPluginHostNavigation(serverId, {
      browserAvailable: getIsElectron(),
      openAgent: navigateToAgent,
      openWorkspace: navigateToWorkspace,
      createBrowser: createWorkspaceBrowser,
      resolveWorkspace: ({ serverId: targetServerId, workspaceId }) =>
        resolveWorkspaceMapKeyByIdentity({
          workspaces: useSessionStore.getState().sessions[targetServerId]?.workspaces,
          workspaceId,
        }),
      hasSurface: (surfaceId) =>
        pluginRegistry
          .getSnapshot()
          .some(
            (plugin) =>
              plugin.serverId === serverId &&
              plugin.id === pluginId &&
              plugin.surfaces.some((surface) => surface.id === surfaceId),
          ),
      openSurface: (surfaceId) =>
        createPluginNavigation({ serverId, workspaceId: null }).openSurface(pluginId, surfaceId),
    }),
    openAgentLaunch: (request) => openPluginAgentLaunch({ serverId, pluginId, request }),
    openOverlay: (Component) => pluginOverlayStore.open({ serverId, pluginId, Component }),
  };
}

export function usePluginHostNavigation(
  serverId: string,
  pluginId: string,
): NonNullable<PluginSurfaceProps["navigation"]> {
  return useMemo(() => buildPluginHostNavigation(serverId, pluginId), [pluginId, serverId]);
}
