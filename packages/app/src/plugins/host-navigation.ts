import { useIsCompactFormFactor, supportsDesktopPaneSplits } from "@/constants/layout";
import { useAppSettings } from "@/hooks/use-settings";
import { resolveWorkspaceTargetPlacement } from "@/workspace-tabs/open-beside";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSessionStore } from "@/stores/session-store";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";
import { useMemo } from "react";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";

import { getIsElectron } from "@/constants/platform";
import { createWorkspaceBrowser } from "@/desktop/browser/store";
import { createPluginHostNavigation } from "./host-navigation-model";

export function usePluginHostNavigation(
  serverId: string,
): NonNullable<PluginSurfaceProps["navigation"]> {
  const compact = useIsCompactFormFactor();
  const terminalOnSide = useAppSettings().settings.openInSidePane.terminals;
  return useMemo(
    () =>
      createPluginHostNavigation(serverId, {
        browserAvailable: getIsElectron(),
        openAgent: navigateToAgent,
        openTerminal: ({ serverId: targetServerId, workspaceId, terminalId }) => {
          const target = { kind: "terminal" as const, terminalId };
          const placement = resolveWorkspaceTargetPlacement({
            workspaceKey: `${targetServerId}:${workspaceId}`,
            target,
            isCompact: compact || !supportsDesktopPaneSplits(),
            location: terminalOnSide ? "side" : "main",
          });
          navigateToWorkspace({ serverId: targetServerId, workspaceId, target, placement });
        },
        openWorkspace: navigateToWorkspace,
        createBrowser: createWorkspaceBrowser,
        resolveWorkspace: ({ serverId: targetServerId, workspaceId }) =>
          resolveWorkspaceMapKeyByIdentity({
            workspaces: useSessionStore.getState().sessions[targetServerId]?.workspaces,
            workspaceId,
          }),
      }),
    [serverId, compact, terminalOnSide],
  );
}
