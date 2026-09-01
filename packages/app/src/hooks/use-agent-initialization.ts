import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { getAgentTimelineSnapshot, publishAgentInitialization } from "@/runtime/session-data";
import {
  createInitDeferred,
  getInitDeferred,
  getInitKey,
  INIT_TIMEOUT_MS,
  rejectInitDeferred,
  refreshInitTimeout,
} from "@/utils/agent-initialization";
import { agentTimelineRuntime } from "@/runtime/host-runtime";
import { planTimelineResumeFetch, planTimelineTailFetch } from "@/timeline/timeline-sync-plan";
import { i18n } from "@/i18n/i18next";

export type SetAgentInitializing = (agentId: string, initializing: boolean) => void;

export function createHistorySyncTimeoutError(): Error {
  return new Error(`History sync timed out after ${Math.round(INIT_TIMEOUT_MS / 1000)}s`);
}

export function refreshAgentInitializationTimeout(input: {
  key: string;
  agentId: string;
  setAgentInitializing: SetAgentInitializing;
}): void {
  refreshInitTimeout({
    key: input.key,
    onTimeout: () => {
      input.setAgentInitializing(input.agentId, false);
      rejectInitDeferred(input.key, createHistorySyncTimeoutError());
    },
  });
}

export interface EnsureAgentIsInitializedInput {
  serverId: string;
  agentId: string;
  client: Pick<DaemonClient, "fetchAgentTimeline"> | null;
  runtime: typeof agentTimelineRuntime;
  setAgentInitializing: SetAgentInitializing;
  hostDisconnectedMessage?: string;
}

export function ensureAgentIsInitialized(input: EnsureAgentIsInitializedInput): Promise<void> {
  const { serverId, agentId, client, setAgentInitializing } = input;
  const key = getInitKey(serverId, agentId);
  const existing = getInitDeferred(key);
  if (existing) {
    return existing.promise;
  }

  const timeline = getAgentTimelineSnapshot(serverId, agentId);
  const timelineRequest = planTimelineResumeFetch(
    timeline.status === "synced" ? timeline.range : null,
  );

  const deferred = createInitDeferred(key, timelineRequest.direction);
  refreshAgentInitializationTimeout({ key, agentId, setAgentInitializing });

  setAgentInitializing(agentId, true);

  if (!client) {
    setAgentInitializing(agentId, false);
    rejectInitDeferred(
      key,
      new Error(input.hostDisconnectedMessage ?? i18n.t("workspace.terminal.hostDisconnected")),
    );
    return deferred.promise;
  }

  input.runtime.fetchAgentTimeline(serverId, agentId, timelineRequest).catch((error) => {
    setAgentInitializing(agentId, false);
    rejectInitDeferred(key, error instanceof Error ? error : new Error(String(error)));
  });

  return deferred.promise;
}

export interface RefreshAgentInput {
  serverId: string;
  agentId: string;
  client: Pick<DaemonClient, "refreshAgent"> | null;
  runtime: typeof agentTimelineRuntime;
  setAgentInitializing: SetAgentInitializing;
  hostDisconnectedMessage?: string;
}

export async function refreshAgent(input: RefreshAgentInput): Promise<void> {
  const { serverId, agentId, client, runtime, setAgentInitializing } = input;
  if (!client) {
    throw new Error(input.hostDisconnectedMessage ?? i18n.t("workspace.terminal.hostDisconnected"));
  }
  setAgentInitializing(agentId, true);

  try {
    await client.refreshAgent(agentId);
    await runtime.fetchAgentTimeline(serverId, agentId, planTimelineTailFetch());
  } catch (error) {
    setAgentInitializing(agentId, false);
    throw error;
  }
}

export function createSetAgentInitializing(
  serverId: string,
  setInitializingAgents: typeof publishAgentInitialization,
): SetAgentInitializing {
  return (agentId, initializing) => {
    setInitializingAgents(serverId, (prev) => {
      if (prev.get(agentId) === initializing) {
        return prev;
      }
      const next = new Map(prev);
      next.set(agentId, initializing);
      return next;
    });
  };
}

export function useAgentInitialization({
  serverId,
  client,
}: {
  serverId: string;
  client: DaemonClient | null;
}) {
  const { t } = useTranslation();
  const setAgentInitializing = useMemo(
    () => createSetAgentInitializing(serverId, publishAgentInitialization),
    [serverId],
  );

  const ensureAgentIsInitializedCallback = useCallback(
    (agentId: string): Promise<void> =>
      ensureAgentIsInitialized({
        serverId,
        agentId,
        client,
        runtime: agentTimelineRuntime,
        setAgentInitializing,
        hostDisconnectedMessage: t("workspace.terminal.hostDisconnected"),
      }),
    [client, serverId, setAgentInitializing, t],
  );

  const refreshAgentCallback = useCallback(
    (agentId: string): Promise<void> =>
      refreshAgent({
        serverId,
        agentId,
        client,
        runtime: agentTimelineRuntime,
        setAgentInitializing,
        hostDisconnectedMessage: t("workspace.terminal.hostDisconnected"),
      }),
    [client, serverId, setAgentInitializing, t],
  );

  return {
    ensureAgentIsInitialized: ensureAgentIsInitializedCallback,
    refreshAgent: refreshAgentCallback,
  };
}
