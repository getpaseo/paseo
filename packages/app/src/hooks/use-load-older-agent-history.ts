import { useCallback } from "react";
import type { ToastApi } from "@/components/toast-host";
import { useSessionStore } from "@/stores/session-store";
import { TIMELINE_FETCH_PAGE_SIZE } from "@/timeline/timeline-fetch-policy";

export function useLoadOlderAgentHistory({
  serverId,
  agentId,
  toast,
}: {
  serverId: string;
  agentId: string;
  toast?: ToastApi | null;
}) {
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const cursor = useSessionStore((state) =>
    state.sessions[serverId]?.agentTimelineCursor.get(agentId),
  );
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
    const latestSession = useSessionStore.getState().sessions[serverId];
    const latestIsLoading = latestSession?.agentTimelineOlderFetchInFlight.get(agentId) === true;
    if (!client || !cursor || !hasOlder || isLoadingOlder || latestIsLoading) {
      return;
    }

    setInFlight(true);
    void client
      .fetchAgentTimeline(agentId, {
        direction: "before",
        cursor: { epoch: cursor.epoch, seq: cursor.startSeq },
        limit: TIMELINE_FETCH_PAGE_SIZE,
        projection: "canonical",
      })
      .catch((error) => {
        console.warn("[Timeline] failed to load older agent history", agentId, error);
        toast?.show("Couldn't load older history", {
          durationMs: 2200,
          testID: "agent-load-older-history-toast",
        });
      })
      .finally(() => {
        setInFlight(false);
      });
  }, [agentId, client, cursor, hasOlder, isLoadingOlder, serverId, setInFlight, toast]);

  return {
    isLoadingOlder,
    hasOlder,
    loadOlder,
  };
}
