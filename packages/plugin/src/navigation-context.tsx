import { createContext, useCallback, useContext, type ReactNode } from "react";
import type { PluginNavigation, PluginOpenWorkspaceOptions } from "./contracts.js";

const PluginNavigationContext = createContext<PluginNavigation | null>(null);

export function PluginNavigationProvider({
  children,
  navigation,
}: {
  children: ReactNode;
  navigation: PluginNavigation;
}) {
  return (
    <PluginNavigationContext.Provider value={navigation}>
      {children}
    </PluginNavigationContext.Provider>
  );
}

export function useOpenExternal(): (url: string) => Promise<void> {
  const navigation = useContext(PluginNavigationContext);
  if (!navigation) {
    throw new Error("useOpenExternal must run inside a contributed plugin surface");
  }
  return useCallback((url: string) => navigation.openExternal(url), [navigation]);
}

export function useOpenWorkspace(): (
  workspaceId: string,
  options?: PluginOpenWorkspaceOptions,
) => void {
  const navigation = useContext(PluginNavigationContext);
  if (!navigation) {
    throw new Error("useOpenWorkspace must run inside a contributed plugin surface");
  }
  return useCallback(
    (workspaceId: string, options?: PluginOpenWorkspaceOptions) => {
      navigation.openWorkspace(workspaceId, options);
    },
    [navigation],
  );
}
