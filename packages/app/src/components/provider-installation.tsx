import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import type {
  ProviderInstallationUpdate,
  ProviderInstallationUpdateProgress,
} from "@getpaseo/protocol/messages";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type {
  ProviderInstallationState,
  ProviderUpdateAction,
  ProviderUpdatesState,
} from "./provider-installation-section";

export interface ProviderInstallationRead {
  state: ProviderInstallationState;
  updates: ProviderUpdatesState;
  /** Absent when the host cannot report provider installations. */
  action: ProviderUpdateAction | undefined;
  /** Ask the provider again, skipping the host's caches. */
  refresh: () => void;
}

/** Folds a progress message into the update it belongs to; a new operation starts empty. */
function applyProgress(
  current: ProviderInstallationUpdate | null,
  progress: ProviderInstallationUpdateProgress,
): ProviderInstallationUpdate {
  const previous = current?.operation.id === progress.operation.id ? current : null;
  return {
    operation: progress.operation,
    output: [...(previous?.output ?? []), ...progress.output],
    ...(previous?.truncated ? { truncated: true } : {}),
  };
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
  // The host owns the update; this view follows it while open and catches up on reopen.
  const [currentUpdate, setCurrentUpdate] = useState<ProviderInstallationUpdate | null>(null);
  useEffect(() => {
    if (!enabled || !client) return;
    const subscription = client.observeProviderUpdates(provider);
    const detach = subscription.subscribe({
      snapshot: (response) => setCurrentUpdate(response.update),
      update: (message) => {
        if (message.type !== "provider.installation.update.progress") return;
        setCurrentUpdate((current) => applyProgress(current, message.payload));
        // The host dropped its cached answers; read the new version and update state.
        if (message.payload.operation.status === "succeeded") {
          void queryClient.invalidateQueries({
            queryKey: ["provider-installation", serverId, provider],
          });
          void queryClient.invalidateQueries({
            queryKey: ["provider-updates", serverId, provider],
          });
        }
      },
      error: (failure) => console.warn("Failed to observe provider updates", failure),
    });
    return () => {
      detach();
      void subscription
        .release()
        .catch((failure) => console.warn("Failed to release provider update observation", failure));
    };
  }, [client, enabled, provider, queryClient, serverId]);
  const startUpdate = useMutation({
    mutationFn: async () => {
      if (!client) throw new Error("Host is not connected");
      const result = await client.updateProvider(provider);
      if (result.error) throw new Error(result.error);
      return result.update;
    },
    onSuccess: (update) => {
      if (!update) return;
      // Progress for this operation may already have arrived; keep the further-along copy.
      setCurrentUpdate((current) =>
        current?.operation.id === update.operation.id ? current : update,
      );
    },
  });
  const { mutate: mutateStartUpdate } = startUpdate;
  const start = useCallback(() => mutateStartUpdate(), [mutateStartUpdate]);
  const action: ProviderUpdateAction | undefined = supported
    ? {
        current: currentUpdate,
        starting: startUpdate.isPending,
        startError: startUpdate.error?.message ?? null,
        start,
      }
    : undefined;

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

  return { state, updates, action, refresh };
}
