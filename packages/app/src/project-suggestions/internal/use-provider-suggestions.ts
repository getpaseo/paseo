import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useFetchQueries } from "@/data/query";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { ProviderSuggestions } from "./suggestions";

type SuggestionsResponse = Awaited<ReturnType<DaemonClient["listProjectSuggestions"]>>;

// History changes slowly. Opening the step still re-asks, keeping the rows already shown.
const SUGGESTIONS_STALE_TIME_MS = 5 * 60 * 1000;

export type ProjectSuggestionsState =
  | { status: "unsupported" }
  /** The provider list itself has not arrived yet. */
  | { status: "loading" }
  | { status: "ready"; providers: ProviderSuggestions[]; retry: (provider: string) => void };

function suggestionsQueryKey(serverId: string, provider: string) {
  return ["project-suggestions", serverId, provider] as const;
}

/**
 * Asks the host for suggestions once per enabled provider, in parallel. The queries are shared, so
 * calling this early (when setup opens) means the Projects step usually finds them answered.
 */
export function useProviderSuggestions(serverId: string): ProjectSuggestionsState {
  const queryClient = useQueryClient();
  const supported = useHostFeature(serverId, "projectSuggestions");
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { entries } = useProvidersSnapshot(serverId, { enabled: supported });
  const providers = useMemo(
    () =>
      entries
        ?.filter((entry) => entry.enabled !== false)
        .map((entry) => ({ id: entry.provider, label: entry.label ?? entry.provider })),
    [entries],
  );

  const results = useFetchQueries<SuggestionsResponse>(
    (supported && providers ? providers : []).map((provider) => ({
      queryKey: suggestionsQueryKey(serverId, provider.id),
      dataShape: "value",
      enabled: Boolean(client) && isConnected,
      // A provider that cannot answer stays failed until the user presses Retry.
      retry: false,
      staleTimeMs: SUGGESTIONS_STALE_TIME_MS,
      queryFn: () => {
        if (!client) throw new Error("Host disconnected");
        return client.listProjectSuggestions({ providers: [provider.id] });
      },
    })),
  );

  const retry = useCallback(
    (provider: string) => {
      void queryClient.refetchQueries({ queryKey: suggestionsQueryKey(serverId, provider) });
    },
    [queryClient, serverId],
  );

  return useMemo((): ProjectSuggestionsState => {
    if (!supported) return { status: "unsupported" };
    if (!providers) return { status: "loading" };
    return {
      status: "ready",
      providers: providers.map((provider, index) =>
        toProviderSuggestions(provider, results[index]),
      ),
      retry,
    };
  }, [supported, providers, results, retry]);
}

function toProviderSuggestions(
  provider: { id: string; label: string },
  result: { data?: SuggestionsResponse; error: Error | null; isFetching: boolean } | undefined,
): ProviderSuggestions {
  const base = { provider: provider.id, label: provider.label };
  const data = result?.data;
  const providerError = data?.providerErrors.find((error) => error.provider === provider.id);
  const failure = result?.error?.message ?? providerError?.message ?? null;
  // A retry shows as reading again; a background refresh of good results keeps the rows.
  if (!result || (result.isFetching && (failure !== null || !data))) {
    return { ...base, status: "loading" };
  }
  if (failure !== null) {
    return { ...base, status: "failed", message: failure, suggestions: data?.suggestions ?? [] };
  }
  if (!data) return { ...base, status: "loading" };
  return { ...base, status: "ready", suggestions: data.suggestions };
}
