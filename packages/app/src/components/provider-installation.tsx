import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProviderInstallationUpdate } from "@getpaseo/protocol/messages";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type {
  ProviderInstallationState,
  ProviderUpdateAction,
  ProviderUpdatesState,
} from "./provider-installation-section";
import { applyProviderUpdateProgress } from "./provider-update-progress";

export interface ProviderInstallationRead {
  state: ProviderInstallationState;
  updates: ProviderUpdatesState;
  /** Absent when the host cannot report provider installations. */
  action: ProviderUpdateAction | undefined;
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
  const { t } = useTranslation();
  const enabled = supported && visible && Boolean(client);
  const installationKey = ["provider-installation", serverId, provider] as const;
  const updatesKey = ["provider-updates", serverId, provider] as const;

  const inspect = useCallback(
    async (refresh: boolean) => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      const result = await client.inspectProviderInstallation(provider, { refresh });
      if (result.error) throw new Error(result.error);
      return result.installation;
    },
    [client, provider, t],
  );
  const checkForUpdates = useCallback(
    async (refresh: boolean) => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      const result = await client.checkProviderUpdates(provider, { refresh });
      if (result.error) throw new Error(result.error);
      return result.updateCheck;
    },
    [client, provider, t],
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

  // A refresh runs through the queries so its answer or its failure is what the screen shows.
  // `staleTime: 0` overrides the app default so the request always goes out.
  const refreshInstallation = useMutation({
    mutationFn: () =>
      queryClient.fetchQuery({
        queryKey: installationKey,
        queryFn: () => inspect(true),
        staleTime: 0,
      }),
  });
  const refreshUpdates = useMutation({
    mutationFn: () =>
      queryClient.fetchQuery({
        queryKey: updatesKey,
        queryFn: () => checkForUpdates(true),
        staleTime: 0,
      }),
  });
  // The host owns the update; this view follows it while open and catches up on reopen.
  const [currentUpdate, setCurrentUpdate] = useState<ProviderInstallationUpdate | null>(null);
  useEffect(() => {
    if (!enabled || !client) return;
    const subscription = client.observeProviderUpdates(provider);
    // The update this view saw running. Its success arrives as live progress, or as the snapshot
    // a reconnect delivers when the progress was missed; either way the host dropped its cached
    // answers, so read the new version and update state.
    let runningId: string | null = null;
    const follow = (operation: ProviderInstallationUpdate["operation"] | undefined) => {
      if (!operation) return;
      if (operation.status === "running") {
        runningId = operation.id;
        return;
      }
      if (operation.id !== runningId) return;
      runningId = null;
      if (operation.status !== "succeeded") return;
      void queryClient.invalidateQueries({
        queryKey: ["provider-installation", serverId, provider],
      });
      void queryClient.invalidateQueries({ queryKey: ["provider-updates", serverId, provider] });
    };
    const detach = subscription.subscribe({
      snapshot: (response) => {
        setCurrentUpdate(response.update);
        follow(response.update?.operation);
      },
      update: (message) => {
        if (message.type !== "provider.installation.update.progress") return;
        setCurrentUpdate((current) => applyProviderUpdateProgress(current, message.payload));
        follow(message.payload.operation);
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
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
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
