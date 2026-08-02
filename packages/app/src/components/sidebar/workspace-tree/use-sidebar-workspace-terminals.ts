import { useMemo } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ListTerminalsResponse } from "@getpaseo/protocol/messages";
import { useSessionStore } from "@/stores/session-store";
import { queryClient } from "@/data/query-client";
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
 * The query runs when the workspace is expanded, and once more when the answer
 * is not yet known, so the sidebar can tell whether a workspace has anything to
 * expand into. Because replica queries never expire (`staleTime` and `gcTime`
 * are both Infinity), that probe happens at most once per workspace per
 * session; afterwards the cached list answers for free and only expanding
 * re-subscribes to updates.
 *
 * The cache is shared, so a terminal created from the workspace screen updates
 * the sidebar immediately through the same `terminals_changed` push — no second
 * probe needed.
 */
export function useSidebarWorkspaceTerminals(input: {
  serverId: string;
  workspaceId: string;
  workspaceDirectory: string | null | undefined;
  /** True when this workspace's subtree is open. */
  expanded: boolean;
}): { terminals: TerminalEntry[] } {
  const client = useSessionStore(
    (state) => (state.sessions[input.serverId]?.client ?? null) as DaemonClient | null,
  );
  const workspaceDirectory = input.workspaceDirectory ?? null;

  const queryKey = useMemo(
    () => buildTerminalsQueryKey(input.serverId, workspaceDirectory, input.workspaceId),
    [input.serverId, input.workspaceId, workspaceDirectory],
  );

  // A synchronous cache peek, so the probe is skipped for workspaces whose
  // terminals are already known — including ones the workspace screen loaded.
  const known = queryClient.getQueryData<ListTerminalsPayload>(queryKey) !== undefined;
  const enabled = (input.expanded || !known) && Boolean(client) && Boolean(workspaceDirectory);

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

  return { terminals: query.data?.terminals ?? EMPTY_TERMINALS };
}
