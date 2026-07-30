import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { type Agent, useSessionStore } from "@/stores/session-store";
import { derivePendingPermissionKey, normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import { applyLegacyDaemonWorkspaceOwnership } from "@/workspace/legacy-daemon-workspaces";

export type FetchAgentResult = Awaited<ReturnType<DaemonClient["fetchAgent"]>>;

/**
 * A fetched agent belongs in the active directory (`agents`) only when it is
 * live and placed; everything else is a detail-only record (`agentDetails`).
 */
function shouldStoreFetchedAgentInActiveDirectory(agent: Agent): boolean {
  return !agent.archivedAt && Boolean(agent.projectPlacement);
}

/**
 * Hydrates a `fetchAgent` payload into the session store and returns the record
 * it wrote.
 *
 * Returning the hydrated record matters: callers that need the agent itself
 * (the fork handler) would otherwise have to re-read the store and guess which
 * of `agents`/`agentDetails` it landed in.
 *
 * Lives here rather than beside the other agent store writers in
 * `@/utils/agent-directory-sync` because it depends on
 * `@/workspace/legacy-daemon-workspaces`, which imports that module — placing it
 * there would close an import cycle.
 */
export function storeFetchedAgentDetail(input: {
  serverId: string;
  result: NonNullable<FetchAgentResult>;
}): Agent {
  const normalized = normalizeAgentSnapshot(input.result.agent, input.serverId);
  const hydrated: Agent = applyLegacyDaemonWorkspaceOwnership({
    serverId: input.serverId,
    agent: {
      ...normalized,
      projectPlacement: input.result.project,
    },
  });
  const store = useSessionStore.getState();

  if (shouldStoreFetchedAgentInActiveDirectory(hydrated)) {
    store.setAgents(input.serverId, (previous) => {
      const next = new Map(previous);
      next.set(hydrated.id, hydrated);
      return next;
    });
  } else {
    store.setAgentDetails(input.serverId, (previous) => {
      const next = new Map(previous);
      next.set(hydrated.id, hydrated);
      return next;
    });
  }

  store.setPendingPermissions(input.serverId, (previous) => {
    const next = new Map(previous);
    for (const [key, pending] of next.entries()) {
      if (pending.agentId === hydrated.id) {
        next.delete(key);
      }
    }
    for (const request of hydrated.pendingPermissions) {
      const key = derivePendingPermissionKey(hydrated.id, request);
      next.set(key, { key, agentId: hydrated.id, request });
    }
    return next;
  });

  return hydrated;
}
