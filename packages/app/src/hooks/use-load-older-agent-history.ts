import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { ToastApi } from "@/components/toast-host";
import { i18n } from "@/i18n/i18next";
import { useSessionStore, type AgentTimelineCursorState } from "@/stores/session-store";
import { planTimelineOlderFetch } from "@/timeline/timeline-sync-plan";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

export interface LoadOlderAgentHistoryClient {
  fetchAgentTimeline: (
    agentId: string,
    request: {
      direction: "before";
      cursor: { epoch: string; seq: number };
      limit: number;
      projection: "projected";
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
  failedMessage?: string;
}

export type LoadOlderAgentHistoryResult = "loaded" | "complete" | "failed";

const olderHistoryRequests = new Map<string, Promise<LoadOlderAgentHistoryResult>>();

export async function loadOlderAgentHistory(
  agentId: string,
  deps: LoadOlderAgentHistoryDeps,
  requestKey = agentId,
): Promise<LoadOlderAgentHistoryResult> {
  const existing = olderHistoryRequests.get(requestKey);
  if (existing) {
    return existing;
  }
  const { client, cursor, hasOlder, isLoadingOlder, setInFlight, toast, logger, failedMessage } =
    deps;
  if (!client || !cursor || !hasOlder || isLoadingOlder) {
    return "complete";
  }

  const request = (async (): Promise<LoadOlderAgentHistoryResult> => {
    setInFlight(true);
    try {
      await client.fetchAgentTimeline(
        agentId,
        planTimelineOlderFetch({ epoch: cursor.epoch, seq: cursor.startSeq }),
      );
      return "loaded";
    } catch (error) {
      (logger ?? console).warn("[Timeline] failed to load older agent history", agentId, error);
      toast?.show(failedMessage ?? i18n.t("loadOlderHistory.failed"), {
        durationMs: 2200,
        testID: "agent-load-older-history-toast",
      });
      return "failed";
    } finally {
      setInFlight(false);
    }
  })();
  olderHistoryRequests.set(requestKey, request);
  try {
    return await request;
  } finally {
    if (olderHistoryRequests.get(requestKey) === request) {
      olderHistoryRequests.delete(requestKey);
    }
  }
}

export async function loadAllOlderAgentHistory({
  agentId,
  requestKey,
  getDeps,
  shouldContinue,
}: {
  agentId: string;
  requestKey: string;
  getDeps: () => LoadOlderAgentHistoryDeps;
  shouldContinue: () => boolean;
}): Promise<LoadOlderAgentHistoryResult> {
  while (shouldContinue()) {
    const deps = getDeps();
    if (!deps.client || !deps.cursor || !deps.hasOlder) {
      return "complete";
    }
    const result = await loadOlderAgentHistory(agentId, deps, requestKey);
    if (result !== "loaded") {
      return result;
    }
  }
  return "complete";
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
  const { t } = useTranslation();
  const hasOlder =
    useSessionStore((state) => state.sessions[serverId]?.agentTimelineHasOlder.get(agentId)) ===
    true;
  const isLoadingOlder =
    useSessionStore((state) =>
      state.sessions[serverId]?.agentTimelineOlderFetchInFlight.get(agentId),
    ) === true;
  const progressKey = useSessionStore((state) => {
    const cursor = state.sessions[serverId]?.agentTimelineCursor.get(agentId);
    return cursor ? `${cursor.epoch}:${cursor.startSeq}` : null;
  });
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

  const loadOlder = useCallback(async (): Promise<boolean> => {
    const session = useSessionStore.getState().sessions[serverId];
    const result = await loadOlderAgentHistory(agentId, {
      client: session?.client
        ? {
            fetchAgentTimeline: (timelineAgentId, request) =>
              getHostRuntimeStore().fetchAgentTimeline(serverId, timelineAgentId, request),
          }
        : null,
      cursor: session?.agentTimelineCursor.get(agentId),
      hasOlder: session?.agentTimelineHasOlder.get(agentId) === true,
      isLoadingOlder: session?.agentTimelineOlderFetchInFlight.get(agentId) === true,
      setInFlight,
      toast,
      failedMessage: t("loadOlderHistory.failed"),
    });
    // Strategy callers treat a true return as "a load was started/finished";
    // false means there is nothing left (or no client/cursor) to fetch.
    return result === "loaded" || result === "failed";
  }, [agentId, serverId, setInFlight, toast, t]);

  const loadAllOlder = useCallback(
    (shouldContinue: () => boolean) =>
      loadAllOlderAgentHistory({
        agentId,
        requestKey: `${serverId}:${agentId}`,
        shouldContinue,
        getDeps: () => {
          const session = useSessionStore.getState().sessions[serverId];
          return {
            client: (session?.client ?? null) as LoadOlderAgentHistoryClient | null,
            cursor: session?.agentTimelineCursor.get(agentId),
            hasOlder: session?.agentTimelineHasOlder.get(agentId) === true,
            isLoadingOlder: session?.agentTimelineOlderFetchInFlight.get(agentId) === true,
            setInFlight,
            toast,
            failedMessage: t("loadOlderHistory.failed"),
          };
        },
      }),
    [agentId, serverId, setInFlight, toast, t],
  );

  return {
    isLoadingOlder,
    hasOlder,
    progressKey,
    loadOlder,
    loadAllOlder,
  };
}
