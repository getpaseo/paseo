import AsyncStorage from "@react-native-async-storage/async-storage";
import { router, useLocalSearchParams, usePathname, type Href } from "expo-router";
import { useEffect, useSyncExternalStore } from "react";
import {
  createLastWorkspaceSelectionStore,
  type ActiveWorkspaceSelection,
  type LastWorkspaceSelectionStorage,
} from "@/stores/last-workspace-selection";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { pickAttentionAgent } from "@/utils/agent-attention";
import {
  buildHostWorkspaceRoute,
  decodeWorkspaceIdFromPathSegment,
  parseHostWorkspaceRouteFromPathname,
} from "@/utils/host-routes";
import {
  resolveWorkspaceIdByExecutionDirectory,
  resolveWorkspaceMapKeyByIdentity,
} from "@/utils/workspace-execution";

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

export function hydrateLastWorkspaceSelection(): Promise<void> {
  return lastWorkspaceSelectionStore.hydrate();
}

export function getLastWorkspaceSelection(): ActiveWorkspaceSelection | null {
  return lastWorkspaceSelectionStore.getSelection();
}

export function getIsLastWorkspaceSelectionHydrated(): boolean {
  return lastWorkspaceSelectionStore.isHydrated();
}

function getParamValue(value: string | string[] | undefined): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    const firstValue = value[0];
    return typeof firstValue === "string" ? firstValue.trim() : "";
  }
  return "";
}

function parseWorkspaceSelectionFromRouteParams(params: {
  serverId?: string | string[];
  workspaceId?: string | string[];
}): ActiveWorkspaceSelection | null {
  const serverId = getParamValue(params.serverId);
  const workspaceValue = getParamValue(params.workspaceId);
  const workspaceId = workspaceValue ? decodeWorkspaceIdFromPathSegment(workspaceValue) : null;
  if (!serverId || !workspaceId) {
    return null;
  }
  return { serverId, workspaceId };
}

export function navigateToWorkspace(
  serverId: string,
  workspaceId: string,
  _options: NavigateToWorkspaceOptions = {},
) {
  const session = useSessionStore.getState().sessions[serverId];
  const resolvedWorkspaceId = resolveWorkspaceMapKeyByIdentity({
    workspaces: session?.workspaces,
    workspaceId,
  });
  const workspaceAgents = resolvedWorkspaceId
    ? Array.from(session?.agents.values() ?? []).filter(
        (agent) =>
          resolveWorkspaceIdByExecutionDirectory({
            workspaces: session?.workspaces?.values(),
            workspaceDirectory: agent.cwd,
          }) === resolvedWorkspaceId,
      )
    : [];
  const attentionAgentId = pickAttentionAgent(workspaceAgents);
  if (attentionAgentId && resolvedWorkspaceId) {
    useWorkspaceLayoutStore.getState().openTabFocused(`${serverId}:${resolvedWorkspaceId}`, {
      kind: "agent",
      agentId: attentionAgentId,
    });
  }

  lastWorkspaceSelectionStore.remember({ serverId, workspaceId });
  const route = buildHostWorkspaceRoute(serverId, workspaceId) as Href;
  router.dismissTo(route);
}

export function navigateToLastWorkspace(): boolean {
  const selection = lastWorkspaceSelectionStore.getSelection();
  if (!selection) {
    return false;
  }
  navigateToWorkspace(selection.serverId, selection.workspaceId);
  return true;
}

export function useActiveWorkspaceSelection(): ActiveWorkspaceSelection | null {
  const params = useLocalSearchParams<{
    serverId?: string | string[];
    workspaceId?: string | string[];
  }>();
  const selection =
    parseHostWorkspaceRouteFromPathname(usePathname()) ??
    parseWorkspaceSelectionFromRouteParams(params);
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
