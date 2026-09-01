import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { ToastApi } from "@/components/toast-host";
import { i18n } from "@/i18n/i18next";
import { useAgentTimeline, type AgentTimelineCursorState } from "@/stores/session-store-hooks";
import {
  getAgentTimelineLoadSnapshot,
  publishOlderTimelineFetch as setOlderFetchInFlight,
} from "@/runtime/session-data";
import { planTimelineOlderFetch } from "@/timeline/timeline-sync-plan";
import { fetchAgentTimeline, getHostClient } from "@/runtime/host-runtime";

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
): Promise<boolean> {
  const { client, cursor, hasOlder, isLoadingOlder, setInFlight, toast, logger, failedMessage } =
    deps;
  if (isLoadingOlder) {
    return true;
  }
  if (!client || !cursor || !hasOlder) {
    return false;
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
  return true;
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
  const timelineState = useAgentTimeline(serverId, agentId, (timeline, meta) => {
    const cursor = timeline.status === "synced" ? timeline.range : null;
    return {
      hasOlder: timeline.status === "synced" && timeline.older === "available",
      isLoadingOlder: meta.isLoadingOlder,
      progressKey: cursor ? `${cursor.epoch}:${cursor.startSeq}` : null,
    };
  });
  const { hasOlder, isLoadingOlder, progressKey } = timelineState;

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
    [agentId, serverId],
  );

  const loadOlder = useCallback(async (): Promise<boolean> => {
    const { timeline, isLoadingOlder: currentIsLoadingOlder } = getAgentTimelineLoadSnapshot(
      serverId,
      agentId,
    );
    return await loadOlderAgentHistory(agentId, {
      client: getHostClient(serverId)
        ? {
            fetchAgentTimeline: (timelineAgentId, request) =>
              fetchAgentTimeline(serverId, timelineAgentId, request),
          }
        : null,
      cursor: timeline.status === "synced" ? (timeline.range ?? undefined) : undefined,
      hasOlder: timeline.status === "synced" && timeline.older === "available",
      isLoadingOlder: currentIsLoadingOlder,
      setInFlight,
      toast,
      failedMessage: t("loadOlderHistory.failed"),
    });
  }, [agentId, serverId, setInFlight, toast, t]);

  return {
    isLoadingOlder,
    hasOlder,
    progressKey,
    loadOlder,
  };
}
