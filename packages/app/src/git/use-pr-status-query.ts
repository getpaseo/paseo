import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { checkoutPrStatusQueryKey } from "@/git/query-keys";
import { normalizeForge } from "@/git/forge";
import { selectPrHintFromStatus, type PrHint } from "@/git/pr-hint";
import { type CheckoutPrStatusPayload, normalizeCheckoutPrStatusPayload } from "@/git/pr-status";

interface UseCheckoutPrStatusQueryOptions {
  serverId: string;
  cwd: string;
  enabled?: boolean;
}

export type { CheckoutPrStatusPayload } from "@/git/pr-status";
export { selectPrHintFromStatus, type PrHint } from "@/git/pr-hint";

function selectWorkspacePrHint(payload: CheckoutPrStatusPayload): PrHint | null {
  return selectPrHintFromStatus(payload.status, payload.forge);
}

export function useCheckoutPrStatusQuery({
  serverId,
  cwd,
  enabled = true,
}: UseCheckoutPrStatusQueryOptions) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);

  const query = useQuery({
    queryKey: checkoutPrStatusQueryKey(serverId, cwd),
    queryFn: async () => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      return normalizeCheckoutPrStatusPayload(await client.checkoutPrStatus(cwd));
    },
    enabled: !!client && isConnected && !!cwd && enabled,
    staleTime: Infinity,
    // Refetch on mount only after explicit invalidation (e.g. reconnect) — see
    // useCheckoutStatusQuery for the rationale.
    refetchOnMount: true,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });

  return {
    status: query.data?.status ?? null,
    githubFeaturesEnabled: query.data?.githubFeaturesEnabled ?? true,
    authState: query.data?.authState,
    forge: normalizeForge(query.data?.forge),
    // Null until a response arrives, so callers that can infer the forge from
    // the remote URL (e.g. web-URL grammar) don't act on the github default.
    resolvedForge: query.data === undefined ? null : normalizeForge(query.data.forge),
    payloadError: query.data?.error ?? null,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
  };
}

export function useWorkspacePrHint({
  serverId,
  cwd,
  enabled = true,
}: UseCheckoutPrStatusQueryOptions): PrHint | null {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);

  const query = useQuery<CheckoutPrStatusPayload, Error, PrHint | null>({
    queryKey: checkoutPrStatusQueryKey(serverId, cwd),
    queryFn: async () => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      return normalizeCheckoutPrStatusPayload(await client.checkoutPrStatus(cwd));
    },
    enabled: !!client && isConnected && !!cwd && enabled,
    staleTime: Infinity,
    // Refetch on mount only after explicit invalidation (e.g. reconnect) — see
    // useCheckoutStatusQuery for the rationale.
    refetchOnMount: true,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    select: selectWorkspacePrHint,
  });

  return query.data ?? null;
}
