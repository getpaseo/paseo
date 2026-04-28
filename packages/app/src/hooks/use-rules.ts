import { useCallback, useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { RuleWithStateDto } from "@server/server/rules/rpc-schemas";
import type { HubcodeRule } from "@server/server/rules/types";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

export type RuleWithState = RuleWithStateDto;

export function rulesListQueryKey(serverId: string | null) {
  return ["rules", "list", serverId] as const;
}

export interface UseRulesResult {
  isConnected: boolean;
  rules: RuleWithState[];
  isLoading: boolean;
  refetch: () => Promise<void>;
  toggle: (ruleId: string, enabled: boolean) => Promise<void>;
  upsert: (rule: HubcodeRule) => Promise<{ error: string | null }>;
  remove: (ruleId: string) => Promise<{ error: string | null }>;
}

export function useRules(serverId: string | null): UseRulesResult {
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const listKey = useMemo(() => rulesListQueryKey(serverId), [serverId]);

  const listQuery = useQuery({
    queryKey: listKey,
    enabled: Boolean(serverId && client && isConnected),
    staleTime: 10_000,
    queryFn: async () => {
      if (!client) throw new Error("Host is not connected");
      const res = await client.rulesList();
      if (res.error) throw new Error(res.error);
      return res.rules as RuleWithState[];
    },
  });

  useEffect(() => {
    if (!client || !isConnected || !serverId) return;
    return client.on("rules/changed", () => {
      void queryClient.invalidateQueries({ queryKey: listKey });
    });
  }, [client, isConnected, serverId, listKey, queryClient]);

  const refetch = useCallback(async () => {
    await listQuery.refetch();
  }, [listQuery]);

  const toggle = useCallback(
    async (ruleId: string, enabled: boolean) => {
      if (!client) return;
      await client.rulesToggle(ruleId, enabled);
      queryClient.setQueryData<RuleWithState[]>(listKey, (prev) =>
        (prev ?? []).map((r) =>
          r.definition.id === ruleId ? { ...r, state: { ...r.state, enabled } } : r,
        ),
      );
    },
    [client, listKey, queryClient],
  );

  const upsert = useCallback(
    async (rule: HubcodeRule) => {
      if (!client) return { error: "Not connected" };
      const res = await client.rulesUpsert(rule);
      void queryClient.invalidateQueries({ queryKey: listKey });
      return { error: res.error };
    },
    [client, listKey, queryClient],
  );

  const remove = useCallback(
    async (ruleId: string) => {
      if (!client) return { error: "Not connected" };
      const res = await client.rulesDelete(ruleId);
      void queryClient.invalidateQueries({ queryKey: listKey });
      return { error: res.error };
    },
    [client, listKey, queryClient],
  );

  return {
    isConnected,
    rules: listQuery.data ?? [],
    isLoading: listQuery.isLoading,
    refetch,
    toggle,
    upsert,
    remove,
  };
}
