import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useTranslation } from "react-i18next";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import {
  useHostRuntimeClient,
  useHostRuntimeConnectionStatus,
  useHostRuntimeIsConnected,
} from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { localizeProviderUsageError } from "./labels";
import type { ProviderUsageListPayload, ProviderUsageView } from "./types";
import { enabledProviderIdsFromSnapshot, selectVisibleProviderUsage } from "./visible-providers";

export const PROVIDER_USAGE_STALE_TIME_MS = 5 * 60 * 1000;

type ProviderUsageClient = Pick<DaemonClient, "listProviderUsage">;

export function providerUsageQueryKey(serverId: string | null | undefined) {
  return ["providerUsage", serverId ?? ""] as const;
}

async function fetchProviderUsage(
  client: ProviderUsageClient,
  options?: { forceRefresh?: boolean },
): Promise<ProviderUsageListPayload> {
  return client.listProviderUsage(
    options?.forceRefresh === true ? { forceRefresh: true } : undefined,
  );
}

interface UseProviderUsageOptions {
  enabled?: boolean;
}

export function useProviderUsage(
  serverId: string | null | undefined,
  options: UseProviderUsageOptions = {},
): {
  view: ProviderUsageView;
  refresh: () => Promise<void>;
  canFetch: boolean;
} {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const connectionStatus = useHostRuntimeConnectionStatus(serverId ?? "");
  const { entries: providerSnapshotEntries } = useProvidersSnapshot(serverId ?? "");
  const enabledProviderIds = useMemo(
    () => enabledProviderIdsFromSnapshot(providerSnapshotEntries),
    [providerSnapshotEntries],
  );
  const serverInfo = useSessionStore((state) => state.sessions[serverId ?? ""]?.serverInfo);
  const hasServerInfo = serverInfo != null;
  const supportsProviderUsage = serverInfo?.features?.providerUsageList === true;
  const queryKey = useMemo(() => providerUsageQueryKey(serverId), [serverId]);
  const canFetch = Boolean(serverId && client && isConnected && supportsProviderUsage);
  const enabled = Boolean((options.enabled ?? true) && canFetch);
  const isConnecting =
    connectionStatus === "connecting" ||
    connectionStatus === "idle" ||
    (connectionStatus === "online" && (!client || !hasServerInfo));

  const queryFn = useCallback(async () => {
    if (!client) {
      throw new Error(t("providerUsage.clientUnavailable"));
    }
    return fetchProviderUsage(client);
  }, [client, t]);

  const query = useQuery({
    queryKey,
    queryFn,
    enabled,
    staleTime: PROVIDER_USAGE_STALE_TIME_MS,
    refetchOnMount: true,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });

  const refresh = useCallback(async () => {
    if (!canFetch || !client) return;
    // Refresh in place — do not invalidate first. Invalidate kicks a second
    // refetch without forceRefresh and can briefly clear/error the view.
    try {
      await queryClient.fetchQuery({
        queryKey,
        queryFn: () => fetchProviderUsage(client, { forceRefresh: true }),
        staleTime: PROVIDER_USAGE_STALE_TIME_MS,
      });
    } catch {
      // Keep the last successful payload visible; the query cache retains it.
    }
  }, [canFetch, client, queryClient, queryKey]);

  const view = useMemo<ProviderUsageView>(() => {
    // Prefer cached usage over transient disconnect / refetch errors so Refresh
    // does not flash the error alert while data is already on screen.
    if (query.data) {
      const providers = selectVisibleProviderUsage({
        providers: query.data.providers,
        enabledProviderIds,
      });
      return {
        kind: "ready",
        payload: { ...query.data, providers },
        isRefreshing: query.isFetching,
      };
    }
    // Page reload / host bootstrap: stay on loading until connection and
    // serverInfo settle. Showing "Connect…" or "Update the host…" here flashes.
    if (!serverId || isConnecting) {
      return { kind: "loading" };
    }
    if (!client || !isConnected || connectionStatus === "offline" || connectionStatus === "error") {
      return { kind: "error", message: t("providerUsage.hostUnavailable") };
    }
    if (hasServerInfo && !supportsProviderUsage) {
      return { kind: "error", message: t("providerUsage.hostUpgradeRequired") };
    }
    if (query.isError) {
      const raw = query.error instanceof Error ? query.error.message : String(query.error);
      return {
        kind: "error",
        message: localizeProviderUsageError(raw),
      };
    }
    return { kind: "loading" };
  }, [
    client,
    connectionStatus,
    enabledProviderIds,
    hasServerInfo,
    isConnected,
    isConnecting,
    query.data,
    query.error,
    query.isError,
    query.isFetching,
    serverId,
    supportsProviderUsage,
    t,
  ]);

  return { view, refresh, canFetch };
}
