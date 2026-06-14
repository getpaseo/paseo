import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { CheckoutPrStatusResponse } from "@getpaseo/protocol/messages";
import { checkoutPrStatusQueryKey } from "@/git/query-keys";

interface UseCheckoutPrStatusQueryOptions {
  serverId: string;
  cwd: string;
  enabled?: boolean;
}

export type CheckoutPrStatusPayload = CheckoutPrStatusResponse["payload"];

export interface PrHint {
  url: string;
  number: number;
  state: "open" | "merged" | "closed";
  checks?: Array<{ name: string; status: string; url: string | null }>;
  checksStatus?: "none" | "pending" | "success" | "failure";
  reviewDecision?: "approved" | "changes_requested" | "pending" | null;
}

interface PrStatusLike {
  url: string;
  state: string;
  isMerged: boolean;
  checks?: Array<{ name: string; status: string; url: string | null }>;
  checksStatus?: string;
  reviewDecision?: string | null;
}

function parsePullRequestNumber(url: string): number | null {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\/pull\/(\d+)(?:\/|$)/);
    if (!match) {
      return null;
    }

    const number = Number.parseInt(match[1], 10);
    return Number.isFinite(number) ? number : null;
  } catch {
    return null;
  }
}

export function selectPrHintFromStatus(status: PrStatusLike | null | undefined): PrHint | null {
  if (!status?.url) {
    return null;
  }

  const number = parsePullRequestNumber(status.url);
  if (number === null) {
    return null;
  }

  let state: "merged" | "open" | "closed";
  if (status.isMerged || status.state === "merged") state = "merged";
  else if (status.state === "open") state = "open";
  else state = "closed";

  return {
    url: status.url,
    number,
    state,
    checks: status.checks,
    checksStatus: status.checksStatus as PrHint["checksStatus"],
    reviewDecision: status.reviewDecision as PrHint["reviewDecision"],
  };
}

function selectWorkspacePrHint(payload: CheckoutPrStatusPayload): PrHint | null {
  return selectPrHintFromStatus(payload.status);
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
      return await client.checkoutPrStatus(cwd);
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
      return await client.checkoutPrStatus(cwd);
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
