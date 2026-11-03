import { useMemo } from "react";
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
  | { status: "ready"; providers: ProviderSuggestions[] };

function suggestionsQueryKey(serverId: string, provider: string) {
  return ["project-suggestions", serverId, provider] as const;
}

/**
 * Asks the host for suggestions once per enabled provider, in parallel. The queries are shared, so
 * calling this early (when setup opens) means the Projects step usually finds them answered.
 */
export function useProviderSuggestions(serverId: string): ProjectSuggestionsState {
  const supported = useHostFeature(serverId, "projectSuggestions");
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { entries } = useProvidersSnapshot(serverId, { enabled: supported });
  const providers = useMemo(
    () => entries?.filter((entry) => entry.enabled !== false).map((entry) => entry.provider),
    [entries],
  );

  const results = useFetchQueries<SuggestionsResponse>(
    (supported && providers ? providers : []).map((provider) => ({
      queryKey: suggestionsQueryKey(serverId, provider),
      dataShape: "value",
      enabled: Boolean(client) && isConnected,
      // Suggestions are a convenience: a provider that cannot answer simply adds nothing.
      retry: false,
      staleTimeMs: SUGGESTIONS_STALE_TIME_MS,
      queryFn: () => {
        if (!client) throw new Error("Host disconnected");
        return client.listProjectSuggestions({ providers: [provider] });
      },
    })),
  );

  return useMemo((): ProjectSuggestionsState => {
    if (!supported) return { status: "unsupported" };
    if (!providers) return { status: "loading" };
    return {
      status: "ready",
      providers: providers.map((provider, index) =>
        toProviderSuggestions(provider, results[index]),
      ),
    };
  }, [supported, providers, results]);
}

function toProviderSuggestions(
  provider: string,
  result: { data?: SuggestionsResponse; error: Error | null; isFetching: boolean } | undefined,
): ProviderSuggestions {
  if (result?.data) {
    return { provider, status: "answered", suggestions: result.data.suggestions };
  }
  if (result?.error && !result.isFetching) {
    return { provider, status: "answered", suggestions: [] };
  }
  return { provider, status: "loading" };
}
