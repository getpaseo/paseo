import { router, type Href } from "expo-router";
import {
  navigateToWorkspace,
  type NavigateToWorkspaceInput,
} from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { findPaneContainingTab, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";
import { buildDeterministicWorkspaceTabId } from "@/workspace-tabs/identity";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { resolveWorkspaceReplay, stepIndex, type HistoryEntry } from "./model";
import { navigationHistoryStore, type NavigationHistoryStore } from "./store";

export interface HistoryReplayDeps {
  navigateToWorkspace: (input: NavigateToWorkspaceInput) => void;
  focusTab: (workspaceKey: string, tabId: string) => void;
  navigateToRoute: (path: string) => void;
  workspaceExists: (serverId: string, workspaceId: string) => boolean;
  tabExists: (workspaceKey: string, tabId: string) => boolean;
  agentExists: (serverId: string, agentId: string) => boolean;
}

const defaultDeps: HistoryReplayDeps = {
  navigateToWorkspace: (input) => {
    navigateToWorkspace(input);
  },
  focusTab: (workspaceKey, tabId) =>
    useWorkspaceLayoutStore.getState().focusTab(workspaceKey, tabId),
  // `navigate`, not `push`: it reuses an identical route already on top, so replaying a settings
  // entry twice does not grow the router stack (see docs/expo-router.md on phantom entries).
  navigateToRoute: (path) => router.navigate(path as Href),
  workspaceExists: (serverId, workspaceId) =>
    resolveWorkspaceMapKeyByIdentity({
      workspaces: useSessionStore.getState().sessions[serverId]?.workspaces,
      workspaceId,
    }) !== null,
  tabExists: (workspaceKey, tabId) => {
    const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    return layout ? findPaneContainingTab(layout.root, tabId) !== null : false;
  },
  agentExists: (serverId, agentId) =>
    useSessionStore.getState().sessions[serverId]?.agents.has(agentId) ?? false,
};

function planForEntry(entry: HistoryEntry, deps: HistoryReplayDeps) {
  if (entry.kind === "route") {
    return null;
  }
  const workspaceKey = buildWorkspaceTabPersistenceKey(entry);
  return resolveWorkspaceReplay(entry, {
    workspaceExists: deps.workspaceExists(entry.serverId, entry.workspaceId),
    tabExists: Boolean(workspaceKey && entry.tabId && deps.tabExists(workspaceKey, entry.tabId)),
    agentExists: (agentId) => deps.agentExists(entry.serverId, agentId),
  });
}

/**
 * Steps the history and navigates to the entry it lands on. Returns false when there is nothing
 * alive in that direction so the shortcut reports itself unhandled.
 *
 * The index moves before anything is dispatched: the recorder compares what it observes against
 * the current entry, so landing on the destination is a no-op rather than a fresh push.
 */
export function goHistory(
  delta: 1 | -1,
  store: NavigationHistoryStore = navigationHistoryStore,
  deps: HistoryReplayDeps = defaultDeps,
): boolean {
  const state = store.getState();
  const nextIndex = stepIndex(state, delta, (entry) => planForEntry(entry, deps)?.kind !== "dead");
  if (nextIndex === null) {
    return false;
  }
  const entry = state.entries[nextIndex];
  if (!entry) {
    return false;
  }
  store.setIndex(nextIndex);

  if (entry.kind === "route") {
    deps.navigateToRoute(entry.path);
    return true;
  }

  const plan = planForEntry(entry, deps);
  const workspaceKey = buildWorkspaceTabPersistenceKey(entry);
  switch (plan?.kind) {
    case "focus":
      // Passing the target keeps navigateToWorkspace from revealing an attention agent instead.
      // Reveal focuses the first tab matching the target, which may be a duplicate, so the exact
      // tab is focused afterwards. Both are synchronous store writes and collapse into one render.
      deps.navigateToWorkspace({
        serverId: entry.serverId,
        workspaceId: entry.workspaceId,
        ...(entry.target ? { target: entry.target } : {}),
      });
      if (workspaceKey) {
        deps.focusTab(workspaceKey, plan.tabId);
      }
      return true;
    case "reopen":
      deps.navigateToWorkspace({
        serverId: entry.serverId,
        workspaceId: entry.workspaceId,
        target: plan.target,
      });
      // Reveal recreates the tab under its deterministic id; the entry has to match it or the
      // recorder would treat the landing as a new place and truncate the forward branch.
      store.replaceCurrent({ ...entry, tabId: buildDeterministicWorkspaceTabId(plan.target) });
      return true;
    case "workspace-only":
      deps.navigateToWorkspace({ serverId: entry.serverId, workspaceId: entry.workspaceId });
      return true;
    default:
      return false;
  }
}
