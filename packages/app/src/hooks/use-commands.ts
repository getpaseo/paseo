import { useCallback, useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CommandWithStateDto } from "@server/server/commands/rpc-schemas";
import type { HubcodeCommand } from "@server/server/commands/types";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

export type CommandWithState = CommandWithStateDto;

export function commandsListQueryKey(serverId: string | null) {
  return ["commands", "list", serverId] as const;
}

export interface UseCommandsResult {
  isConnected: boolean;
  commands: CommandWithState[];
  isLoading: boolean;
  refetch: () => Promise<void>;
  toggle: (commandId: string, enabled: boolean) => Promise<void>;
  upsert: (command: HubcodeCommand) => Promise<{ error: string | null }>;
  remove: (commandId: string) => Promise<{ error: string | null }>;
}

/**
 * Lists Hubcode commands and exposes toggle/upsert/delete. Subscribes to
 * `commands/changed` push events so install-status updates after a sync
 * arrive without a manual refetch.
 */
export function useCommands(serverId: string | null): UseCommandsResult {
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const listKey = useMemo(() => commandsListQueryKey(serverId), [serverId]);

  const listQuery = useQuery({
    queryKey: listKey,
    enabled: Boolean(serverId && client && isConnected),
    staleTime: 10_000,
    queryFn: async () => {
      if (!client) throw new Error("Host is not connected");
      const res = await client.commandsList();
      if (res.error) throw new Error(res.error);
      return res.commands as CommandWithState[];
    },
  });

  useEffect(() => {
    if (!client || !isConnected || !serverId) return;
    return client.on("commands/changed", () => {
      void queryClient.invalidateQueries({ queryKey: listKey });
    });
  }, [client, isConnected, serverId, listKey, queryClient]);

  const refetch = useCallback(async () => {
    await listQuery.refetch();
  }, [listQuery]);

  const toggle = useCallback(
    async (commandId: string, enabled: boolean) => {
      if (!client) return;
      await client.commandsToggle(commandId, enabled);
      queryClient.setQueryData<CommandWithState[]>(listKey, (prev) =>
        (prev ?? []).map((c) =>
          c.definition.id === commandId ? { ...c, state: { ...c.state, enabled } } : c,
        ),
      );
    },
    [client, listKey, queryClient],
  );

  const upsert = useCallback(
    async (command: HubcodeCommand) => {
      if (!client) return { error: "Not connected" };
      const res = await client.commandsUpsert(command);
      void queryClient.invalidateQueries({ queryKey: listKey });
      return { error: res.error };
    },
    [client, listKey, queryClient],
  );

  const remove = useCallback(
    async (commandId: string) => {
      if (!client) return { error: "Not connected" };
      const res = await client.commandsDelete(commandId);
      void queryClient.invalidateQueries({ queryKey: listKey });
      return { error: res.error };
    },
    [client, listKey, queryClient],
  );

  return {
    isConnected,
    commands: listQuery.data ?? [],
    isLoading: listQuery.isLoading,
    refetch,
    toggle,
    upsert,
    remove,
  };
}
