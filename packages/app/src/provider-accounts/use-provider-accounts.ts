import { useCallback, useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  DaemonClient,
  ProviderAccountStatePayload,
} from "@getpaseo/client/internal/daemon-client";
import type {
  ProviderAccountProfile,
  ProviderAccountLogin,
  ProviderAccountProvider,
} from "@getpaseo/protocol/provider-accounts";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useFetchQuery } from "@/data/query";

type ProviderAccountClient = Pick<
  DaemonClient,
  | "listProviderAccounts"
  | "createProviderAccount"
  | "renameProviderAccount"
  | "setDefaultProviderAccount"
  | "removeProviderAccount"
  | "startProviderAccountLogin"
  | "getProviderAccountLoginStatus"
  | "cancelProviderAccountLogin"
>;

type ProviderAccountMutation =
  | { kind: "create"; provider: ProviderAccountProvider; name: string }
  | { kind: "rename"; accountProfileId: string; name: string }
  | { kind: "default"; provider: ProviderAccountProvider; accountProfileId: string | null }
  | { kind: "remove"; accountProfileId: string };

export type ProviderAccountsView =
  | { kind: "loading" }
  | { kind: "unavailable"; reason: "disconnected" | "unsupported" }
  | { kind: "error"; message: string }
  | { kind: "ready"; state: ProviderAccountStatePayload };

export interface ProviderAccountOperations {
  create: (provider: ProviderAccountProvider, name: string) => Promise<void>;
  rename: (accountProfileId: string, name: string) => Promise<void>;
  setDefault: (provider: ProviderAccountProvider, accountProfileId: string | null) => Promise<void>;
  remove: (accountProfileId: string) => Promise<void>;
  startLogin: (accountProfileId: string) => Promise<ProviderAccountLogin>;
  getLoginStatus: (accountProfileId: string) => Promise<ProviderAccountLogin>;
  cancelLogin: (accountProfileId: string) => Promise<ProviderAccountLogin>;
  refresh: () => Promise<void>;
  isMutating: boolean;
}

export function providerAccountsQueryKey(serverId: string | null | undefined) {
  return ["providerAccounts", serverId ?? ""] as const;
}

async function runMutation(
  client: ProviderAccountClient,
  mutation: ProviderAccountMutation,
): Promise<ProviderAccountStatePayload> {
  switch (mutation.kind) {
    case "create":
      return client.createProviderAccount(mutation);
    case "rename":
      return client.renameProviderAccount(mutation);
    case "default":
      return client.setDefaultProviderAccount(mutation);
    case "remove":
      return client.removeProviderAccount(mutation);
  }
}

export function useProviderAccounts(serverId: string | null): {
  view: ProviderAccountsView;
  accounts: ProviderAccountProfile[];
  defaults: Partial<Record<ProviderAccountProvider, string | null>>;
  operations: ProviderAccountOperations;
} {
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const isSupported = useSessionStore(
    (state) =>
      state.sessions[serverId ?? ""]?.serverInfo?.features?.providerAccountProfiles === true,
  );
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => providerAccountsQueryKey(serverId), [serverId]);
  const canFetch = Boolean(serverId && client && isConnected && isSupported);

  const query = useFetchQuery({
    queryKey,
    dataShape: "value",
    staleTimeMs: 30_000,
    queryFn: async () => {
      if (!client) throw new Error("Provider account client unavailable");
      return client.listProviderAccounts();
    },
    enabled: canFetch,
  });

  const mutation = useMutation({
    mutationFn: async (input: ProviderAccountMutation) => {
      if (!client) throw new Error("Provider account client unavailable");
      return runMutation(client, input);
    },
    onSuccess: (state) => queryClient.setQueryData(queryKey, state),
  });

  const execute = useCallback(
    async (input: ProviderAccountMutation) => {
      await mutation.mutateAsync(input);
    },
    [mutation],
  );
  const refresh = useCallback(async () => {
    if (!canFetch) return;
    await queryClient.invalidateQueries({ queryKey });
  }, [canFetch, queryClient, queryKey]);
  const applyLoginPayload = useCallback(
    (payload: Awaited<ReturnType<DaemonClient["getProviderAccountLoginStatus"]>>) => {
      queryClient.setQueryData(queryKey, {
        requestId: payload.requestId,
        accounts: payload.accounts,
        defaults: payload.defaults,
      });
      return payload.login;
    },
    [queryClient, queryKey],
  );
  const startLogin = useCallback(
    async (accountProfileId: string) => {
      if (!client) throw new Error("Provider account client unavailable");
      return applyLoginPayload(await client.startProviderAccountLogin({ accountProfileId }));
    },
    [applyLoginPayload, client],
  );
  const getLoginStatus = useCallback(
    async (accountProfileId: string) => {
      if (!client) throw new Error("Provider account client unavailable");
      return applyLoginPayload(await client.getProviderAccountLoginStatus({ accountProfileId }));
    },
    [applyLoginPayload, client],
  );
  const cancelLogin = useCallback(
    async (accountProfileId: string) => {
      if (!client) throw new Error("Provider account client unavailable");
      return applyLoginPayload(await client.cancelProviderAccountLogin({ accountProfileId }));
    },
    [applyLoginPayload, client],
  );

  const operations = useMemo<ProviderAccountOperations>(
    () => ({
      create: (provider, name) => execute({ kind: "create", provider, name }),
      rename: (accountProfileId, name) => execute({ kind: "rename", accountProfileId, name }),
      setDefault: (provider, accountProfileId) =>
        execute({ kind: "default", provider, accountProfileId }),
      remove: (accountProfileId) => execute({ kind: "remove", accountProfileId }),
      startLogin,
      getLoginStatus,
      cancelLogin,
      refresh,
      isMutating: mutation.isPending,
    }),
    [cancelLogin, execute, getLoginStatus, mutation.isPending, refresh, startLogin],
  );

  const view = useMemo<ProviderAccountsView>(() => {
    if (!isConnected || !client) return { kind: "unavailable", reason: "disconnected" };
    if (!isSupported) return { kind: "unavailable", reason: "unsupported" };
    if (query.data) return { kind: "ready", state: query.data };
    if (query.isError) {
      return {
        kind: "error",
        message: query.error instanceof Error ? query.error.message : String(query.error),
      };
    }
    return { kind: "loading" };
  }, [client, isConnected, isSupported, query.data, query.error, query.isError]);

  return {
    view,
    accounts: query.data?.accounts ?? [],
    defaults: query.data?.defaults ?? {},
    operations,
  };
}
