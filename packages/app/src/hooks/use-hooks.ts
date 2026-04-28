import { useCallback, useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { HookWithStateDto } from "@server/server/hooks/rpc-schemas";
import type { HubcodeHook } from "@server/server/hooks/types";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

export type HookWithState = HookWithStateDto;

export function hooksListQueryKey(serverId: string | null) {
  return ["hooks", "list", serverId] as const;
}

export interface UseHooksResult {
  isConnected: boolean;
  hooks: HookWithState[];
  isLoading: boolean;
  refetch: () => Promise<void>;
  toggle: (hookId: string, enabled: boolean) => Promise<void>;
  upsert: (hook: HubcodeHook) => Promise<{ error: string | null }>;
  remove: (hookId: string) => Promise<{ error: string | null }>;
}

/**
 * Lists the hooks registry and exposes toggle/upsert/delete. Listens to
 * `hooks/changed` push events (also emitted for telemetry ticks) to keep
 * the fired-counter in sync.
 */
export function useHooks(serverId: string | null): UseHooksResult {
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const listKey = useMemo(() => hooksListQueryKey(serverId), [serverId]);

  const listQuery = useQuery({
    queryKey: listKey,
    enabled: Boolean(serverId && client && isConnected),
    staleTime: 10_000,
    queryFn: async () => {
      if (!client) throw new Error("Host is not connected");
      const res = await client.hooksList();
      if (res.error) throw new Error(res.error);
      return res.hooks as HookWithState[];
    },
  });

  useEffect(() => {
    if (!client || !isConnected || !serverId) return;
    return client.on("hooks/changed", () => {
      void queryClient.invalidateQueries({ queryKey: listKey });
    });
  }, [client, isConnected, serverId, listKey, queryClient]);

  const refetch = useCallback(async () => {
    await listQuery.refetch();
  }, [listQuery]);

  const toggle = useCallback(
    async (hookId: string, enabled: boolean) => {
      if (!client) return;
      await client.hooksToggle(hookId, enabled);
      queryClient.setQueryData<HookWithState[]>(listKey, (prev) =>
        (prev ?? []).map((h) =>
          h.definition.id === hookId ? { ...h, state: { ...h.state, enabled } } : h,
        ),
      );
    },
    [client, listKey, queryClient],
  );

  const upsert = useCallback(
    async (hook: HubcodeHook) => {
      if (!client) return { error: "Not connected" };
      const res = await client.hooksUpsert(hook);
      void queryClient.invalidateQueries({ queryKey: listKey });
      return { error: res.error };
    },
    [client, listKey, queryClient],
  );

  const remove = useCallback(
    async (hookId: string) => {
      if (!client) return { error: "Not connected" };
      const res = await client.hooksDelete(hookId);
      void queryClient.invalidateQueries({ queryKey: listKey });
      return { error: res.error };
    },
    [client, listKey, queryClient],
  );

  return {
    isConnected,
    hooks: listQuery.data ?? [],
    isLoading: listQuery.isLoading,
    refetch,
    toggle,
    upsert,
    remove,
  };
}
