import AsyncStorage from "@react-native-async-storage/async-storage";
import { router, useLocalSearchParams, usePathname, type Href } from "expo-router";
import { useEffect, useSyncExternalStore } from "react";
import {
  createLastWorkspaceSelectionStore,
  type ActiveWorkspaceSelection,
  type LastWorkspaceSelectionStorage,
} from "@/stores/last-workspace-selection";
import {
  navigateToLastWorkspace as navigateToLastWorkspacePure,
  navigateToWorkspace as navigateToWorkspacePure,
  parseActiveWorkspaceSelection,
  type NavigateToWorkspaceDeps,
} from "./navigation";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";

export type { ActiveWorkspaceSelection } from "@/stores/last-workspace-selection";

interface NavigateToWorkspaceOptions {
  currentPathname?: string | null;
}

const LAST_WORKSPACE_SELECTION_STORAGE_KEY = "paseo:last-workspace-route-selection";

const lastWorkspaceSelectionStorage: LastWorkspaceSelectionStorage = {
  read: () => AsyncStorage.getItem(LAST_WORKSPACE_SELECTION_STORAGE_KEY),
  write: (value) => AsyncStorage.setItem(LAST_WORKSPACE_SELECTION_STORAGE_KEY, value),
};

const lastWorkspaceSelectionStore = createLastWorkspaceSelectionStore(
  lastWorkspaceSelectionStorage,
);

function navigateDeps(): NavigateToWorkspaceDeps {
  return {
    getSessionWorkspaces: (serverId) => useSessionStore.getState().sessions[serverId]?.workspaces,
    getSessionAgents: (serverId) =>
      useSessionStore.getState().sessions[serverId]?.agents.values() ?? [],
    openWorkspaceAgentTab: (workspaceKey, agentId) => {
      useWorkspaceLayoutStore.getState().openTabFocused(workspaceKey, { kind: "agent", agentId });
    },
    rememberLastWorkspace: (selection) => lastWorkspaceSelectionStore.remember(selection),
    navigateToRoute: (route) => router.dismissTo(route as Href),
  };
}

export function hydrateLastWorkspaceSelection(): Promise<void> {
  return lastWorkspaceSelectionStore.hydrate();
}

export function getLastWorkspaceSelection(): ActiveWorkspaceSelection | null {
  return lastWorkspaceSelectionStore.getSelection();
}

export function getIsLastWorkspaceSelectionHydrated(): boolean {
  return lastWorkspaceSelectionStore.isHydrated();
}

export function navigateToWorkspace(
  serverId: string,
  workspaceId: string,
  _options: NavigateToWorkspaceOptions = {},
) {
  navigateToWorkspacePure(serverId, workspaceId, navigateDeps());
}

export function navigateToLastWorkspace(): boolean {
  return navigateToLastWorkspacePure({
    ...navigateDeps(),
    getLastWorkspaceSelection: () => lastWorkspaceSelectionStore.getSelection(),
  });
}

export function useActiveWorkspaceSelection(): ActiveWorkspaceSelection | null {
  const params = useLocalSearchParams<{
    serverId?: string | string[];
    workspaceId?: string | string[];
  }>();
  const selection = parseActiveWorkspaceSelection({ pathname: usePathname(), params });
  const serverId = selection?.serverId ?? null;
  const workspaceId = selection?.workspaceId ?? null;
  useEffect(() => {
    if (!serverId || !workspaceId) {
      return;
    }
    lastWorkspaceSelectionStore.remember({ serverId, workspaceId });
  }, [serverId, workspaceId]);
  return selection;
}

export function useLastWorkspaceSelection(): ActiveWorkspaceSelection | null {
  return useSyncExternalStore(
    lastWorkspaceSelectionStore.subscribe,
    getLastWorkspaceSelection,
    getLastWorkspaceSelection,
  );
}

export function useIsLastWorkspaceSelectionHydrated(): boolean {
  return useSyncExternalStore(
    lastWorkspaceSelectionStore.subscribe,
    getIsLastWorkspaceSelectionHydrated,
    getIsLastWorkspaceSelectionHydrated,
  );
}

void hydrateLastWorkspaceSelection();
