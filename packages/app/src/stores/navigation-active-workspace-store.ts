import AsyncStorage from "@react-native-async-storage/async-storage";
import { router, useLocalSearchParams, usePathname, type Href } from "expo-router";
import { useEffect, useSyncExternalStore } from "react";
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

export interface ActiveWorkspaceSelection {
  serverId: string;
  workspaceId: string;
}

interface NavigateToWorkspaceOptions {
  currentPathname?: string | null;
}

const LAST_WORKSPACE_SELECTION_STORAGE_KEY = "paseo:last-workspace-route-selection";

let lastWorkspaceSelection: ActiveWorkspaceSelection | null = null;
let lastWorkspaceSelectionHydrated = false;
let lastWorkspaceSelectionHydrationPromise: Promise<void> | null = null;
let lastWorkspaceSelectionRevision = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notifyListeners() {
  for (const listener of listeners) {
    listener();
  }
}

function normalizeWorkspaceSelection(input: unknown): ActiveWorkspaceSelection | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const record = input as Record<string, unknown>;
  const serverId = typeof record.serverId === "string" ? record.serverId.trim() : "";
  const workspaceId = typeof record.workspaceId === "string" ? record.workspaceId.trim() : "";
  if (!serverId || !workspaceId) {
    return null;
  }
  return { serverId, workspaceId };
}

function parseStoredWorkspaceSelection(stored: string | null): ActiveWorkspaceSelection | null {
  if (!stored) {
    return null;
  }
  try {
    return normalizeWorkspaceSelection(JSON.parse(stored));
  } catch {
    return null;
  }
}

function setLastWorkspaceSelection(next: ActiveWorkspaceSelection) {
  const normalized = normalizeWorkspaceSelection(next);
  if (!normalized) {
    return;
  }
  if (
    lastWorkspaceSelection?.serverId === normalized.serverId &&
    lastWorkspaceSelection.workspaceId === normalized.workspaceId
  ) {
    return;
  }
  lastWorkspaceSelection = normalized;
  lastWorkspaceSelectionRevision += 1;
  notifyListeners();
  void AsyncStorage.setItem(LAST_WORKSPACE_SELECTION_STORAGE_KEY, JSON.stringify(normalized)).catch(
    () => {},
  );
}

export function hydrateLastWorkspaceSelection(): Promise<void> {
  if (lastWorkspaceSelectionHydrationPromise) {
    return lastWorkspaceSelectionHydrationPromise;
  }
  const hydrationRevision = lastWorkspaceSelectionRevision;
  lastWorkspaceSelectionHydrationPromise = AsyncStorage.getItem(
    LAST_WORKSPACE_SELECTION_STORAGE_KEY,
  )
    .then((stored) => {
      if (lastWorkspaceSelectionRevision === hydrationRevision) {
        lastWorkspaceSelection = parseStoredWorkspaceSelection(stored);
      }
      return undefined;
    })
    .catch(() => {
      if (lastWorkspaceSelectionRevision === hydrationRevision) {
        lastWorkspaceSelection = null;
      }
    })
    .finally(() => {
      lastWorkspaceSelectionHydrated = true;
      notifyListeners();
    });
  return lastWorkspaceSelectionHydrationPromise;
}

export function getLastWorkspaceSelection(): ActiveWorkspaceSelection | null {
  return lastWorkspaceSelection;
}

export function getIsLastWorkspaceSelectionHydrated(): boolean {
  return lastWorkspaceSelectionHydrated;
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

  setLastWorkspaceSelection({ serverId, workspaceId });
  const route = buildHostWorkspaceRoute(serverId, workspaceId) as Href;
  router.dismissTo(route);
}

export function navigateToLastWorkspace(): boolean {
  if (!lastWorkspaceSelection) {
    return false;
  }
  navigateToWorkspace(lastWorkspaceSelection.serverId, lastWorkspaceSelection.workspaceId);
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
    setLastWorkspaceSelection({ serverId, workspaceId });
  }, [serverId, workspaceId]);
  return selection;
}

export function useLastWorkspaceSelection(): ActiveWorkspaceSelection | null {
  return useSyncExternalStore(subscribe, getLastWorkspaceSelection, getLastWorkspaceSelection);
}

export function useIsLastWorkspaceSelectionHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    getIsLastWorkspaceSelectionHydrated,
    getIsLastWorkspaceSelectionHydrated,
  );
}

void hydrateLastWorkspaceSelection();
