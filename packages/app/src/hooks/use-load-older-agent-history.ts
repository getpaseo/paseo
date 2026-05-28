import { useCallback } from "react";
import type { ToastApi } from "@/components/toast-host";
import { useSessionStore, type AgentTimelineCursorState } from "@/stores/session-store";
import { TIMELINE_FETCH_PAGE_SIZE } from "@/timeline/timeline-fetch-policy";

export interface LoadOlderAgentHistoryClient {
  fetchAgentTimeline: (
    agentId: string,
    request: {
      direction: "before";
      cursor: { epoch: string; seq: number };
      limit: number;
      projection: "canonical";
    },
  ) => Promise<unknown>;
}

export interface LoadOlderAgentHistoryLogger {
  warn: (...args: unknown[]) => void;
}

export interface LoadOlderAgentHistoryDeps {
  client: LoadOlderAgentHistoryClient | null;
  cursor: AgentTimelineCursorState | undefined;
  hasOlder: boolean;
  isLoadingOlder: boolean;
  setInFlight: (value: boolean) => void;
  toast?: ToastApi | null;
  logger?: LoadOlderAgentHistoryLogger;
}

export async function loadOlderAgentHistory(
  agentId: string,
  deps: LoadOlderAgentHistoryDeps,
): Promise<void> {
  const { client, cursor, hasOlder, isLoadingOlder, setInFlight, toast, logger } = deps;
  if (!client || !cursor || !hasOlder || isLoadingOlder) {
    return;
  }

  setInFlight(true);
  try {
    await client.fetchAgentTimeline(agentId, {
      direction: "before",
      cursor: { epoch: cursor.epoch, seq: cursor.startSeq },
      limit: TIMELINE_FETCH_PAGE_SIZE,
      projection: "canonical",
    });
  } catch (error) {
    (logger ?? console).warn("[Timeline] failed to load older agent history", agentId, error);
    toast?.show("Couldn't load older history", {
      durationMs: 2200,
      testID: "agent-load-older-history-toast",
    });
  } finally {
    setInFlight(false);
  }
}

export function useLoadOlderAgentHistory({
  serverId,
  agentId,
  toast,
}: {
  serverId: string;
  agentId: string;
  toast?: ToastApi | null;
}) {
  const hasOlder =
    useSessionStore((state) => state.sessions[serverId]?.agentTimelineHasOlder.get(agentId)) ===
    true;
  const isLoadingOlder =
    useSessionStore((state) =>
      state.sessions[serverId]?.agentTimelineOlderFetchInFlight.get(agentId),
    ) === true;
  const setOlderFetchInFlight = useSessionStore(
    (state) => state.setAgentTimelineOlderFetchInFlight,
  );

  const setInFlight = useCallback(
    (value: boolean) => {
      setOlderFetchInFlight(serverId, (prev) => {
        if (prev.get(agentId) === value) {
          return prev;
        }
        const next = new Map(prev);
        next.set(agentId, value);
        return next;
      });
    },
    [agentId, serverId, setOlderFetchInFlight],
  );

  const loadOlder = useCallback(() => {
    const session = useSessionStore.getState().sessions[serverId];
    void loadOlderAgentHistory(agentId, {
      client: (session?.client ?? null) as LoadOlderAgentHistoryClient | null,
      cursor: session?.agentTimelineCursor.get(agentId),
      hasOlder: session?.agentTimelineHasOlder.get(agentId) === true,
      isLoadingOlder: session?.agentTimelineOlderFetchInFlight.get(agentId) === true,
      setInFlight,
      toast,
    });
  }, [agentId, serverId, setInFlight, toast]);

  return {
    isLoadingOlder,
    hasOlder,
    loadOlder,
  };
}
