import { useCallback, useState } from "react";
import { useHosts, useHostRuntimeClient } from "@/runtime/host-runtime";
import { useLibraryEntries } from "./use-library-queries";
import {
  type LibraryEntry,
  type LibrarySyncTarget,
  type McpPayload,
  type SkillPayload,
} from "@/api/library";

export interface SyncLibraryResult {
  counts: Record<LibrarySyncTarget, { mcp: number; skill: number }>;
  runningAgentIds: string[];
  /** Epoch ms when the sync completed — drives the "Synced X ago" banner. */
  at: number;
}

/**
 * Push the user's currently activated library entries to the connected daemon
 * so it can write them to the local CLI configs (~/.claude.json, etc.). Uses
 * the first connected host since the daemon is per-machine.
 */
export function useSyncLibrary(sessionToken: string | null) {
  const hosts = useHosts();
  const primaryServerId = hosts[0]?.serverId ?? null;
  const client = useHostRuntimeClient(primaryServerId ?? "");
  const entriesQuery = useLibraryEntries(sessionToken, undefined);

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<SyncLibraryResult | null>(null);

  const sync = useCallback(async () => {
    console.log("[library-sync] click", {
      hasClient: !!client,
      hasEntries: !!entriesQuery.data,
      entryCount: entriesQuery.data?.length ?? 0,
      primaryServerId,
    });
    if (!client) {
      setError("Hubcode daemon is not connected");
      console.warn("[library-sync] aborted: no daemon client");
      return null;
    }
    setError(null);
    setPending(true);
    try {
      const entries = entriesQuery.data ?? [];
      const mcps = entries
        .filter((e): e is LibraryEntry & { kind: "mcp" } => e.kind === "mcp")
        .filter((e) => e.activation?.active)
        .map((e) => ({
          id: e.id,
          name: e.name,
          payload: e.payload as McpPayload,
          syncTargets: e.activation!.syncTargets,
        }));
      const skills = entries
        .filter((e): e is LibraryEntry & { kind: "skill" } => e.kind === "skill")
        .filter((e) => e.activation?.active)
        .map((e) => {
          const payload = e.payload as SkillPayload;
          return {
            id: e.id,
            name: e.name,
            displayName: e.displayName,
            description: e.description ?? undefined,
            payload: { ...payload } as Record<string, unknown> & SkillPayload,
            syncTargets: e.activation!.syncTargets,
          };
        });
      console.log("[library-sync] sending to daemon", {
        mcps: mcps.length,
        skills: skills.length,
      });
      const result = await client.syncLibrary({ mcps, skills });
      console.log("[library-sync] success", result);
      const stamped: SyncLibraryResult = { ...result, at: Date.now() };
      setLastResult(stamped);
      return stamped;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[library-sync] failed", err);
      setError(message);
      return null;
    } finally {
      setPending(false);
    }
  }, [client, entriesQuery.data, primaryServerId]);

  return {
    sync,
    pending,
    error,
    lastResult,
    canSync: client !== null,
  };
}
