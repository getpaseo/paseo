import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ProviderCliStatus } from "@getpaseo/protocol/provider-cli/rpc-schemas";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

const BUSY_POLL_INTERVAL_MS = 1500;

const providerCliQueryKey = (serverId: string) => ["provider-cli", serverId] as const;

function isBusy(status: ProviderCliStatus): boolean {
  return status.update.status === "running" || status.login?.status === "running";
}

export interface ProviderCli {
  /** False when the host predates provider CLI management. */
  isSupported: boolean;
  statuses: ProviderCliStatus[];
  isLoading: boolean;
  isChecking: boolean;
  error: Error | null;
  getStatus: (provider: string) => ProviderCliStatus | null;
  checkForUpdates: () => Promise<void>;
  update: (provider: string) => Promise<void>;
  startLogin: (provider: string) => Promise<void>;
  sendLoginInput: (provider: string, text: string) => Promise<void>;
  cancelLogin: (provider: string) => Promise<void>;
}

// The daemon reports update and sign-in progress through the status list, so the list polls
// while either is running.
export function useProviderCli(serverId: string): ProviderCli {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const isSupported = useHostFeature(serverId, "providerCli");
  const queryClient = useQueryClient();
  const [isChecking, setIsChecking] = useState(false);
  const queryKey = useMemo(() => providerCliQueryKey(serverId), [serverId]);

  const query = useFetchQuery({
    queryKey,
    enabled: Boolean(client && isConnected && isSupported),
    dataShape: "list",
    staleTimeMs: 30_000,
    queryFn: () => {
      if (!client) throw new Error("Host is disconnected");
      return client.listProviderCliStatus();
    },
    refetchInterval: (current) =>
      current.state.data?.some(isBusy) ? BUSY_POLL_INTERVAL_MS : false,
  });
  const { refetch } = query;
  const statuses = useMemo(() => query.data ?? [], [query.data]);

  const getStatus = useCallback(
    (provider: string) => statuses.find((status) => status.provider === provider) ?? null,
    [statuses],
  );

  const checkForUpdates = useCallback(async () => {
    if (!client) return;
    setIsChecking(true);
    try {
      const next = await client.listProviderCliStatus({ refresh: true });
      queryClient.setQueryData(queryKey, next);
    } finally {
      setIsChecking(false);
    }
  }, [client, queryClient, queryKey]);

  const runAndRefetch = useCallback(
    async (action: () => Promise<void>) => {
      await action();
      await refetch();
    },
    [refetch],
  );

  const update = useCallback(
    (provider: string) =>
      runAndRefetch(async () => {
        await client?.startProviderCliUpdate(provider);
      }),
    [client, runAndRefetch],
  );
  const startLogin = useCallback(
    (provider: string) =>
      runAndRefetch(async () => {
        await client?.startProviderCliLogin(provider);
      }),
    [client, runAndRefetch],
  );
  const sendLoginInput = useCallback(
    (provider: string, text: string) =>
      runAndRefetch(async () => {
        await client?.sendProviderCliLoginInput(provider, text);
      }),
    [client, runAndRefetch],
  );
  const cancelLogin = useCallback(
    (provider: string) =>
      runAndRefetch(async () => {
        await client?.cancelProviderCliLogin(provider);
      }),
    [client, runAndRefetch],
  );

  return {
    isSupported,
    statuses,
    isLoading: query.isLoading,
    isChecking,
    error: query.error,
    getStatus,
    checkForUpdates,
    update,
    startLogin,
    sendLoginInput,
    cancelLogin,
  };
}
