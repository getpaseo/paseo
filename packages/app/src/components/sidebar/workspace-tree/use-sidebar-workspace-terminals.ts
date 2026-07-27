import { useMemo } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ListTerminalsResponse } from "@getpaseo/protocol/messages";
import { useSessionStore } from "@/stores/session-store";
import { useReplicaQuery } from "@/data/query";
import { workspaceTerminalsPushRoute } from "@/data/push-router";
import {
  buildTerminalsQueryKey,
  type ListTerminalsPayload,
} from "@/screens/workspace/terminals/state";

type TerminalEntry = ListTerminalsPayload["terminals"][number];

const EMPTY_TERMINALS: TerminalEntry[] = [];

/**
 * Read the terminal list for a single workspace. Mirrors the workspace screen's
 * terminals query (same query key, same `terminals_changed` push route) so the
 * sidebar and an open workspace pane share one cache entry.
 *
 * `enabled` is gated on the workspace tree being expanded, so collapsed
 * workspaces never issue or subscribe to a terminals query.
 */
export function useSidebarWorkspaceTerminals(input: {
  serverId: string;
  workspaceId: string;
  workspaceDirectory: string | null | undefined;
  enabled: boolean;
}): { terminals: TerminalEntry[]; isLoading: boolean } {
  const client = useSessionStore(
    (state) => (state.sessions[input.serverId]?.client ?? null) as DaemonClient | null,
  );
  const workspaceDirectory = input.workspaceDirectory ?? null;
  const enabled = input.enabled && Boolean(client) && Boolean(workspaceDirectory);

  const queryKey = useMemo(
    () => buildTerminalsQueryKey(input.serverId, workspaceDirectory, input.workspaceId),
    [input.serverId, input.workspaceId, workspaceDirectory],
  );

  const query = useReplicaQuery<ListTerminalsResponse["payload"]>({
    queryKey,
    enabled,
    pushEvent: "terminals_changed",
    meta: workspaceTerminalsPushRoute({
      enabled,
      serverId: input.serverId,
      cwd: workspaceDirectory ?? "",
      workspaceId: input.workspaceId,
    }),
    queryFn: async () => {
      if (!client || !workspaceDirectory) {
        throw new Error("Workspace directory not available");
      }
      return client.listTerminals(workspaceDirectory, undefined, {
        workspaceId: input.workspaceId,
      });
    },
  });

  const terminals = query.data?.terminals ?? EMPTY_TERMINALS;
  return { terminals, isLoading: enabled && query.isLoading && !query.data };
}
