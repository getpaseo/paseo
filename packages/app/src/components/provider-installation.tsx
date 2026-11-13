import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type {
  ProviderInstallationState,
  ProviderUpdatesState,
} from "./provider-installation-section";

export interface ProviderInstallationRead {
  state: ProviderInstallationState;
  updates: ProviderUpdatesState;
  /** Ask the provider again, skipping the host's caches. */
  refresh: () => void;
}

/**
 * Reads a provider's installation from hosts that advertise `providerInstallation`. The update
 * check is a separate request that starts once the provider reports itself installed, so the
 * installed version never waits on it.
 */
export function useProviderInstallation(input: {
  serverId: string;
  provider: string;
  visible: boolean;
}): ProviderInstallationRead {
  const { serverId, provider, visible } = input;
  const supported = useHostFeature(serverId, "providerInstallation");
  const client = useHostRuntimeClient(serverId);
  const queryClient = useQueryClient();
  const enabled = supported && visible && Boolean(client);
  const installationKey = ["provider-installation", serverId, provider] as const;
  const updatesKey = ["provider-updates", serverId, provider] as const;

  const inspect = useCallback(
    async (refresh: boolean) => {
      if (!client) throw new Error("Host is not connected");
      const result = await client.inspectProviderInstallation(provider, { refresh });
      if (result.error) throw new Error(result.error);
      return result.installation;
    },
    [client, provider],
  );
  const checkForUpdates = useCallback(
    async (refresh: boolean) => {
      if (!client) throw new Error("Host is not connected");
      const result = await client.checkProviderUpdates(provider, { refresh });
      if (result.error) throw new Error(result.error);
      return result.updateCheck;
    },
    [client, provider],
  );

  // The host caches both answers, so reading on every open is cheap.
  const installationQuery = useFetchQuery({
    queryKey: installationKey,
    queryFn: () => inspect(false),
    enabled,
    dataShape: "value",
    staleTimeMs: 0,
  });
  const installed = installationQuery.data?.inspection?.status === "installed";
  const updatesQuery = useFetchQuery({
    queryKey: updatesKey,
    queryFn: () => checkForUpdates(false),
    enabled: enabled && installed,
    dataShape: "value",
    staleTimeMs: 0,
  });

  const refreshInstallation = useMutation({
    mutationFn: () => inspect(true),
    onSuccess: (installation) => queryClient.setQueryData(installationKey, installation),
  });
  const refreshUpdates = useMutation({
    mutationFn: () => checkForUpdates(true),
    onSuccess: (updateCheck) => queryClient.setQueryData(updatesKey, updateCheck),
  });
  const { mutate: mutateInstallation } = refreshInstallation;
  const { mutate: mutateUpdates } = refreshUpdates;
  const refresh = useCallback(() => {
    if (!supported || !client) return;
    mutateInstallation();
    if (installed) mutateUpdates();
  }, [client, installed, mutateInstallation, mutateUpdates, supported]);

  let state: ProviderInstallationState;
  if (!supported) state = { status: "unsupported" };
  else if (installationQuery.isPending || refreshInstallation.isPending)
    state = { status: "loading" };
  else if (installationQuery.isError)
    state = { status: "error", message: installationQuery.error.message };
  else state = { status: "ready", installation: installationQuery.data ?? null };

  let updates: ProviderUpdatesState;
  if (!supported || !installed) updates = { status: "hidden" };
  else if (updatesQuery.isPending || refreshUpdates.isPending) updates = { status: "loading" };
  else if (updatesQuery.isError) updates = { status: "error", message: updatesQuery.error.message };
  else if (updatesQuery.data) updates = { status: "ready", updateCheck: updatesQuery.data };
  else updates = { status: "hidden" };

  return { state, updates, refresh };
}
