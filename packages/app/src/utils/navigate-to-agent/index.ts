import { router, type Href } from "expo-router";
import { useSessionStore } from "@/stores/session-store";
import { buildWorkspaceTabPersistenceKey } from "@/stores/workspace-tabs-store";
import { getHostRuntimeStore, isHostRuntimeConnected } from "@/runtime/host-runtime";
import { resolveNavigateToAgent, type NavigateToAgentInput } from "./resolve";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";

export type { NavigateToAgentInput } from "./resolve";

// Clears the transient restoring state if the daemon resolves refreshAgent without
// re-emitting a workspace_update (the directory-gone case), so the gate never spins
// forever. Recreating a worktree can require a git fetch, so the budget is generous
// to avoid flashing a false "failed" on a capable daemon doing slow real work.
const RESTORE_TIMEOUT_MS = 30000;

interface PendingWorkspaceRestore {
  target: HistoryWorkspaceRestore;
  unsubscribe: () => void;
}

interface HistoryWorkspaceRestore {
  serverId: string;
  agentId: string;
  workspaceId: string;
  agentArchived: boolean;
}

const pendingWorkspaceRestores = new Map<string, PendingWorkspaceRestore>();

function restoreWhenWorkspacesHydrate(target: HistoryWorkspaceRestore): void {
  const { serverId, workspaceId } = target;
  const key = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  if (!key) {
    return;
  }

  const pending = pendingWorkspaceRestores.get(key);
  if (pending) {
    pending.target = target;
    return;
  }

  const restore: PendingWorkspaceRestore = {
    target,
    unsubscribe: () => {},
  };
  restore.unsubscribe = useSessionStore.subscribe((state) => {
    const session = state.sessions[serverId];
    if (session && !session.hasHydratedWorkspaces) {
      return;
    }

    restore.unsubscribe();
    pendingWorkspaceRestores.delete(key);
    if (session) {
      restoreArchivedWorkspace(restore.target);
    }
  });
  pendingWorkspaceRestores.set(key, restore);
}

function restoreArchivedWorkspace(target: HistoryWorkspaceRestore): void {
  const { serverId, agentId, workspaceId, agentArchived } = target;
  const snapshot = getHostRuntimeStore().getSnapshot(serverId);
  const client = snapshot?.client ?? null;
  if (!client || !isHostRuntimeConnected(snapshot)) {
    return;
  }

  const store = useSessionStore.getState();
  const session = store.sessions[serverId];
  if (!session) {
    return;
  }
  if (session.restoringWorkspaces.get(workspaceId) === "restoring") {
    return;
  }
  // An empty workspace map is not authoritative during startup. Keep the route on
  // its existing loading state, then decide whether restoration is needed once the
  // daemon's workspace snapshot has landed.
  if (!session.hasHydratedWorkspaces) {
    restoreWhenWorkspacesHydrate(target);
    return;
  }

  // Workspace and agent archive lifecycles are independent. A missing workspace
  // must restore even when its agent survived unarchived; an archived agent must
  // still reopen when its workspace survived.
  if (session.workspaces.has(workspaceId)) {
    if (agentArchived) {
      client.refreshAgent(agentId).catch((error) => {
        console.error("[HistoryRestore] Failed to reopen archived agent", {
          serverId,
          agentId,
          error,
        });
      });
    }
    return;
  }

  // COMPAT(worktreeRestore): added in v0.1.97, drop the gate when floor >= v0.1.97
  // Single capability read for restore. An old daemon recreates nothing on
  // refresh_agent, so a gone directory would spin then flash a misleading
  // "couldn't restore". Surface an explicit "update your host" state instead.
  if (session.serverInfo?.features?.worktreeRestore !== true) {
    store.setWorkspaceRestoreStatus(serverId, workspaceId, "needs-host-upgrade");
    return;
  }

  store.setWorkspaceRestoreStatus(serverId, workspaceId, "restoring");
  // The reducer guards "failed" so a late timeout after the descriptor lands is a no-op.
  setTimeout(
    () => useSessionStore.getState().setWorkspaceRestoreStatus(serverId, workspaceId, "failed"),
    RESTORE_TIMEOUT_MS,
  );
  client
    .refreshAgent(agentId)
    .catch(() =>
      useSessionStore.getState().setWorkspaceRestoreStatus(serverId, workspaceId, "failed"),
    );
}

export function navigateToAgent(input: NavigateToAgentInput): string {
  return resolveNavigateToAgent(input, {
    readAgentNavTarget: ({ serverId, agentId }) => {
      const session = useSessionStore.getState().sessions[serverId];
      const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
      return {
        agentWorkspaceId: agent?.workspaceId,
      };
    },
    navigateToHostAgent: (route) => {
      router.navigate(route as Href);
    },
    navigateToWorkspace,
    restoreArchivedWorkspace,
  });
}
