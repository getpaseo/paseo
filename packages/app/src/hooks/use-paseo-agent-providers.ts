import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type {
  PaseoAgentCatalogEntry,
  PaseoAgentOAuthCompleteResponse,
  PaseoAgentOAuthStartResponse,
  PaseoAgentRenameProviderRequest,
  PaseoAgentSetProviderRequest,
  RedactedPaseoAgentProviderConfig,
} from "@getpaseo/protocol/messages";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

export function paseoAgentProvidersQueryKey(serverId: string | null) {
  return ["paseo-agent-providers", serverId] as const;
}

export function paseoAgentCatalogQueryKey(serverId: string | null) {
  return ["paseo-agent-catalog", serverId] as const;
}

function describeQueryError(error: unknown): string | null {
  if (!error) {
    return null;
  }
  return error instanceof Error ? error.message : String(error);
}

export type PaseoAgentSetProviderInput = Omit<PaseoAgentSetProviderRequest, "type" | "requestId">;
export type PaseoAgentRenameProviderInput = Omit<
  PaseoAgentRenameProviderRequest,
  "type" | "requestId"
>;
export type PaseoAgentOAuthStartResult = PaseoAgentOAuthStartResponse["payload"];
export type PaseoAgentOAuthCompleteResult = PaseoAgentOAuthCompleteResponse["payload"];

interface UsePaseoAgentProvidersResult {
  supported: boolean;
  catalogSupported: boolean;
  providers: RedactedPaseoAgentProviderConfig[];
  catalog: PaseoAgentCatalogEntry[];
  defaultModel: string | null;
  isLoading: boolean;
  isCatalogLoading: boolean;
  error: string | null;
  catalogError: string | null;
  refresh: () => Promise<void>;
  setProvider: (
    input: PaseoAgentSetProviderInput,
  ) => Promise<RedactedPaseoAgentProviderConfig | null>;
  renameProvider: (
    input: PaseoAgentRenameProviderInput,
  ) => Promise<RedactedPaseoAgentProviderConfig | null>;
  startOAuth: (name: string, mode?: string) => Promise<PaseoAgentOAuthStartResult>;
  completeOAuth: (name: string) => Promise<PaseoAgentOAuthCompleteResult>;
}

export function usePaseoAgentProviders(serverId: string | null): UsePaseoAgentProvidersResult {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const hostDisconnectedMessage = t("workspace.terminal.hostDisconnected");
  const saveProviderFailedMessage = t("settings.host.providers.addErrorTitle");
  // COMPAT(paseoAgentConfig): added in v0.1.85, remove gate after 2026-11-30.
  const supported = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.paseoAgentConfig === true,
  );
  // COMPAT(paseoAgentCatalog): added in v0.1.104, drop the gate when floor >= v0.1.104.
  const catalogSupported = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.paseoAgentCatalog === true,
  );
  const queryKey = useMemo(() => paseoAgentProvidersQueryKey(serverId), [serverId]);
  const catalogQueryKey = useMemo(() => paseoAgentCatalogQueryKey(serverId), [serverId]);

  const query = useQuery({
    queryKey,
    enabled: Boolean(supported && serverId && client && isConnected),
    staleTime: 30_000,
    queryFn: async () => {
      if (!client) {
        throw new Error(hostDisconnectedMessage);
      }
      return client.getPaseoAgentProviders();
    },
  });

  const catalogQuery = useQuery({
    queryKey: catalogQueryKey,
    enabled: Boolean(supported && catalogSupported && serverId && client && isConnected),
    staleTime: 30_000,
    queryFn: async () => {
      if (!client) {
        throw new Error(hostDisconnectedMessage);
      }
      return client.getPaseoAgentCatalog();
    },
  });

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey });
    await queryClient.invalidateQueries({ queryKey: catalogQueryKey });
  }, [catalogQueryKey, queryClient, queryKey]);

  const error = query.data?.error ?? describeQueryError(query.error);
  const catalogError = catalogQuery.data?.error ?? describeQueryError(catalogQuery.error);

  const setProviderMutation = useMutation({
    mutationFn: async (input: PaseoAgentSetProviderInput) => {
      if (!client) {
        throw new Error(hostDisconnectedMessage);
      }
      const result = await client.setPaseoAgentProvider(input);
      if (!result.success) {
        throw new Error(result.error ?? saveProviderFailedMessage);
      }
      return result.provider;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });
  const { mutateAsync: setProviderAsync } = setProviderMutation;

  const setProvider = useCallback(
    (input: PaseoAgentSetProviderInput) => setProviderAsync(input),
    [setProviderAsync],
  );

  const renameProviderMutation = useMutation({
    mutationFn: async (input: PaseoAgentRenameProviderInput) => {
      if (!client) {
        throw new Error(hostDisconnectedMessage);
      }
      const result = await client.renamePaseoAgentProvider(input);
      if (!result.success) {
        throw new Error(result.error ?? saveProviderFailedMessage);
      }
      return result.provider;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });
  const { mutateAsync: renameProviderAsync } = renameProviderMutation;

  const renameProvider = useCallback(
    (input: PaseoAgentRenameProviderInput) => renameProviderAsync(input),
    [renameProviderAsync],
  );

  const startOAuthMutation = useMutation({
    mutationFn: async (input: { name: string; mode?: string }) => {
      if (!client) {
        throw new Error(hostDisconnectedMessage);
      }
      const result = await client.startPaseoAgentOAuth(input.name, { mode: input.mode });
      if (!result.success) {
        throw new Error(result.error ?? saveProviderFailedMessage);
      }
      return result;
    },
  });
  const { mutateAsync: startOAuthAsync } = startOAuthMutation;

  const startOAuth = useCallback(
    (name: string, mode?: string) => startOAuthAsync(mode ? { name, mode } : { name }),
    [startOAuthAsync],
  );

  const completeOAuthMutation = useMutation({
    mutationFn: async (name: string) => {
      if (!client) {
        throw new Error(hostDisconnectedMessage);
      }
      const result = await client.completePaseoAgentOAuth(name);
      if (!result.success) {
        throw new Error(result.error ?? saveProviderFailedMessage);
      }
      return result;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });
  const { mutateAsync: completeOAuthAsync } = completeOAuthMutation;

  const completeOAuth = useCallback(
    (name: string) => completeOAuthAsync(name),
    [completeOAuthAsync],
  );

  return {
    supported,
    catalogSupported,
    providers: query.data?.providers ?? [],
    catalog: catalogQuery.data?.catalog ?? [],
    defaultModel: query.data?.defaultModel ?? null,
    isLoading: query.isLoading,
    isCatalogLoading: catalogQuery.isLoading,
    error,
    catalogError,
    refresh,
    setProvider,
    renameProvider,
    startOAuth,
    completeOAuth,
  };
}
