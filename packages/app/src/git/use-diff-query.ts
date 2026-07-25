import { useMemo } from "react";
import { useReplicaQuery } from "@/data/query";
import { checkoutDiffPushRoute } from "@/data/push-router";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { ParsedDiffFile, SubscribeCheckoutDiffResponse } from "@getpaseo/protocol/messages";
import { checkoutDiffQueryKey } from "@/git/query-keys";

interface UseCheckoutDiffQueryOptions {
  serverId: string;
  cwd: string;
  mode: "uncommitted" | "base";
  baseRef?: string;
  ignoreWhitespace?: boolean;
  enabled?: boolean;
  queryScope?: string;
}

type CheckoutDiffQueryPayload = Omit<SubscribeCheckoutDiffResponse["payload"], "subscriptionId">;

// Re-export the canonical protocol type so all consumers share one definition.
export type { ParsedDiffFile };
export type DiffHunk = ParsedDiffFile["hunks"][number];
export type DiffLine = DiffHunk["lines"][number];
export type HighlightToken = NonNullable<DiffLine["tokens"]>[number];

function normalizeCheckoutDiffCompare(compare: {
  mode: "uncommitted" | "base";
  baseRef?: string;
  ignoreWhitespace?: boolean;
}): { mode: "uncommitted" | "base"; baseRef?: string; ignoreWhitespace?: boolean } {
  const ignoreWhitespace = compare.ignoreWhitespace === true;
  if (compare.mode === "uncommitted") {
    return { mode: "uncommitted", ignoreWhitespace };
  }
  const trimmedBaseRef = compare.baseRef?.trim();
  return trimmedBaseRef
    ? { mode: "base", baseRef: trimmedBaseRef, ignoreWhitespace }
    : { mode: "base", ignoreWhitespace };
}

export function useCheckoutDiffQuery({
  serverId,
  cwd,
  mode,
  baseRef,
  ignoreWhitespace,
  enabled = true,
  queryScope,
}: UseCheckoutDiffQueryOptions) {
  const isConnected = useHostRuntimeIsConnected(serverId);
  const normalizedCompare = useMemo(
    () => normalizeCheckoutDiffCompare({ mode, baseRef, ignoreWhitespace }),
    [mode, baseRef, ignoreWhitespace],
  );
  const compareMode = normalizedCompare.mode;
  const compareBaseRef = normalizedCompare.baseRef;
  const compareIgnoreWhitespace = normalizedCompare.ignoreWhitespace;
  const queryKey = useMemo(() => {
    const comparisonKey = checkoutDiffQueryKey(
      serverId,
      cwd,
      compareMode,
      compareBaseRef,
      compareIgnoreWhitespace,
    );
    const normalizedScope = queryScope?.trim();
    return normalizedScope ? [...comparisonKey, "scope", normalizedScope] : comparisonKey;
  }, [serverId, cwd, compareMode, compareBaseRef, compareIgnoreWhitespace, queryScope]);
  const subscriptionId = useMemo(() => `checkoutDiff:${JSON.stringify(queryKey)}`, [queryKey]);
  const routeEnabled = Boolean(enabled && isConnected && cwd);

  const query = useReplicaQuery<CheckoutDiffQueryPayload>({
    queryKey,
    enabled: routeEnabled,
    pushEvent: "checkout_diff_update",
    meta: checkoutDiffPushRoute({
      enabled: routeEnabled,
      serverId,
      subscriptionId,
      cwd,
      compare: {
        mode: compareMode,
        ...(compareBaseRef ? { baseRef: compareBaseRef } : {}),
        ignoreWhitespace: compareIgnoreWhitespace,
      },
    }),
  });

  const payload = query.data ?? null;
  const payloadError = payload?.error ?? null;

  return {
    files: payload?.files ?? [],
    payloadError,
    isLoading: payload === null && enabled && isConnected,
    isFetching: false,
    isError: Boolean(payloadError),
    error: null,
  };
}
