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

export async function loadOlderAgentHistory(
  agentId: string,
  deps: LoadOlderAgentHistoryDeps,
): Promise<void> {
  const { client, cursor, hasOlder, isLoadingOlder, setInFlight, toast, logger, failedMessage } =
    deps;
  if (!client || !cursor || !hasOlder || isLoadingOlder) {
    return;
  }

  setInFlight(true);
  try {
    await client.fetchAgentTimeline(
      agentId,
      planTimelineOlderFetch({ epoch: cursor.epoch, seq: cursor.startSeq }),
    );
  } catch (error) {
    (logger ?? console).warn("[Timeline] failed to load older agent history", agentId, error);
    toast?.show(failedMessage ?? i18n.t("loadOlderHistory.failed"), {
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
  const { t } = useTranslation();
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
  }, [agentId, serverId, setInFlight, toast, t]);

  return {
    isLoadingOlder,
    hasOlder,
    loadOlder,
  };
}
