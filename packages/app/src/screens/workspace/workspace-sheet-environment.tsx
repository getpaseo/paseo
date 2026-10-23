import React, { useCallback, useContext } from "react";
import { NavigationContext, NavigationRouteContext } from "expo-router/react-navigation";
import { useAssistantFileLinkEnvironmentBridge } from "@/assistant-file-links";
import { useComposerEditingEnvironmentBridge } from "@/composer/editing-session";
import { RetainedPanelActivity, useRetainedPanelActive } from "@/components/retained-panel";
import type { ContextBridge } from "@/components/ui/isolated-bottom-sheet-modal";
import { useDiffDocumentWorkspaceCacheBridge } from "@/git/diff-document/workspace-cache";
import { HostRouteProvider, useHostRouteServerId } from "@/navigation/host-route-context";

/** The environment of the built-in compact panels; pane identity is supplied by their body. */
export function useWorkspaceSheetEnvironment(): ContextBridge {
  const editing = useComposerEditingEnvironmentBridge();
  const cache = useDiffDocumentWorkspaceCacheBridge();
  const files = useAssistantFileLinkEnvironmentBridge();
  const active = useRetainedPanelActive();
  const serverId = useHostRouteServerId();
  const navigation = useContext(NavigationContext);
  const route = useContext(NavigationRouteContext);
  return useCallback(
    (children) => {
      const content = editing(cache(files(children)));
      return (
        <NavigationContext.Provider value={navigation}>
          <NavigationRouteContext.Provider value={route}>
            <RetainedPanelActivity active={active}>
              {serverId ? (
                <HostRouteProvider serverId={serverId}>{content}</HostRouteProvider>
              ) : (
                content
              )}
            </RetainedPanelActivity>
          </NavigationRouteContext.Provider>
        </NavigationContext.Provider>
      );
    },
    [editing, cache, files, active, serverId, navigation, route],
  );
}
