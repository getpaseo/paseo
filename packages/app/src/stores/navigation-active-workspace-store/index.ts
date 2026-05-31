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

let activeWorkspaceSelection: ActiveWorkspaceSelection | null = null;
const activeWorkspaceSelectionListeners = new Set<() => void>();

function activeWorkspaceSelectionsEqual(
  left: ActiveWorkspaceSelection | null,
  right: ActiveWorkspaceSelection | null,
): boolean {
  return left?.serverId === right?.serverId && left?.workspaceId === right?.workspaceId;
}

function publishActiveWorkspaceSelection(selection: ActiveWorkspaceSelection | null): void {
  if (activeWorkspaceSelectionsEqual(activeWorkspaceSelection, selection)) {
    return;
  }
  activeWorkspaceSelection = selection;
  for (const listener of activeWorkspaceSelectionListeners) {
    listener();
  }
}

function subscribeActiveWorkspaceSelection(listener: () => void): () => void {
  activeWorkspaceSelectionListeners.add(listener);
  return () => activeWorkspaceSelectionListeners.delete(listener);
}

export function getActiveWorkspaceSelection(): ActiveWorkspaceSelection | null {
  return activeWorkspaceSelection;
}

function selectIsActiveWorkspace(
  serverId: string | null,
  workspaceId: string,
  enabled: boolean,
): boolean {
  return (
    enabled &&
    activeWorkspaceSelection?.serverId === serverId &&
    activeWorkspaceSelection.workspaceId === workspaceId
  );
}

export function useIsActiveWorkspaceSelection(
  serverId: string | null,
  workspaceId: string,
  enabled: boolean,
): boolean {
  return useSyncExternalStore(
    subscribeActiveWorkspaceSelection,
    () => selectIsActiveWorkspace(serverId, workspaceId, enabled),
    () => selectIsActiveWorkspace(serverId, workspaceId, enabled),
  );
}

function selectIsActiveWorkspaceInSet(
  serverId: string | null,
  workspaceIds: ReadonlySet<string>,
  enabled: boolean,
): boolean {
  return (
    enabled &&
    activeWorkspaceSelection?.serverId === serverId &&
    workspaceIds.has(activeWorkspaceSelection.workspaceId)
  );
}

export function useIsActiveWorkspaceInSet(
  serverId: string | null,
  workspaceIds: ReadonlySet<string>,
  enabled: boolean,
): boolean {
  return useSyncExternalStore(
    subscribeActiveWorkspaceSelection,
    () => selectIsActiveWorkspaceInSet(serverId, workspaceIds, enabled),
    () => selectIsActiveWorkspaceInSet(serverId, workspaceIds, enabled),
  );
}

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
    publishActiveWorkspaceSelection(serverId && workspaceId ? { serverId, workspaceId } : null);
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
