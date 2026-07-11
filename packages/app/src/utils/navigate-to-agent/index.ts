import { router, type Href } from "expo-router";
import { useSessionStore } from "@/stores/session-store";
import { getHostRuntimeStore, isHostRuntimeConnected } from "@/runtime/host-runtime";
import { resolveNavigateToAgent, type NavigateToAgentInput } from "./resolve";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";

export type { NavigateToAgentInput } from "./resolve";

// Clears the transient restoring state if the daemon resolves refreshAgent without
// re-emitting a workspace_update (the directory-gone case), so the gate never spins
// forever. Recreating a worktree can require a git fetch, so the budget is generous
// to avoid flashing a false "failed" on a capable daemon doing slow real work.
const RESTORE_TIMEOUT_MS = 30000;

function restoreArchivedWorkspace(serverId: string, agentId: string, workspaceId: string): void {
  const snapshot = getHostRuntimeStore().getSnapshot(serverId);
  const client = snapshot?.client ?? null;
  if (!client || !isHostRuntimeConnected(snapshot)) {
    return;
  }

  const store = useSessionStore.getState();
  const session = store.sessions[serverId];
  // History carries restore intent explicitly. Workspace lifecycle is separate
  // from agent lifecycle, so a closed non-archived agent can legitimately own an
  // archived workspace. A present workspace or in-flight restore stays a no-op.
  if (session?.workspaces.has(workspaceId)) {
    return;
  }
  if (session?.restoringWorkspaces.get(workspaceId) === "restoring") {
    return;
  }

  // COMPAT(worktreeRestore): added in v0.1.97, drop the gate when floor >= v0.1.97
  // Single capability read for restore. An old daemon recreates nothing on
  // refresh_agent, so a gone directory would spin then flash a misleading
  // "couldn't restore". Surface an explicit "update your host" state instead.
  if (session?.serverInfo?.features?.worktreeRestore !== true) {
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
    restoreArchivedWorkspace: ({ serverId, agentId, workspaceId }) => {
      restoreArchivedWorkspace(serverId, agentId, workspaceId);
    },
  });
}
