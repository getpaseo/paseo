import { useEffect } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useSessionStore } from "@/stores/session-store";
import { refreshProviderSubagents } from "@/subagents/provider-store";

/**
 * Parents already requested, keyed by the client that requested them. A
 * reconnect hands us a new client object, which drops the old set and lets the
 * fresh connection re-hydrate — the same keying `refreshProviderSubagents` uses
 * for its own in-flight deduplication.
 */
const requestedParentsByClient = new WeakMap<object, Set<string>>();

function requestedParents(client: object): Set<string> {
  const existing = requestedParentsByClient.get(client);
  if (existing) {
    return existing;
  }
  const created = new Set<string>();
  requestedParentsByClient.set(client, created);
  return created;
}

/**
 * Load the provider subagents (OMP task children, Claude sidechains) of a
 * workspace's agents once its subtree is opened.
 *
 * Live subagent activity arrives unsolicited over `agent.provider_subagents.update`,
 * so the store stays current on its own — but subagents that already existed
 * when the app connected are only in the daemon's list, not the store. Without
 * this the sidebar would show a parent with no children until you opened that
 * agent's subagents track.
 *
 * Costs one `listProviderSubagents` request per Paseo agent, once per
 * connection, and only for workspaces the user actually expands. Re-running the
 * effect is a no-op: the per-client set skips anything already requested.
 */
export function useHydrateProviderSubagents(input: {
  serverId: string;
  agentIds: readonly string[];
  enabled: boolean;
}): void {
  const { serverId, agentIds, enabled } = input;
  const client = useSessionStore(
    (state) => (state.sessions[serverId]?.client ?? null) as DaemonClient | null,
  );
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.providerSubagents === true,
  );

  useEffect(() => {
    if (!enabled || !supported || !client || agentIds.length === 0) {
      return;
    }
    const pending = requestedParents(client);
    for (const agentId of agentIds) {
      const key = `${serverId}\0${agentId}`;
      if (pending.has(key)) {
        continue;
      }
      pending.add(key);
      void refreshProviderSubagents(client, serverId, agentId).catch(() => {
        // Let a later expand retry a failed load rather than caching the failure.
        pending.delete(key);
      });
    }
  }, [agentIds, client, enabled, serverId, supported]);
}
