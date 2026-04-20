import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo } from "react";
import { useIsCompactFormFactor } from "@/constants/layout";
import { usePanelStore } from "@/stores/panel-store";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { SubscribeCheckoutDiffResponse } from "@server/shared/messages";
import { orderCheckoutDiffFiles } from "./checkout-diff-order";

function checkoutDiffQueryKey(
  serverId: string,
  cwd: string,
  mode: "uncommitted" | "base",
  baseRef?: string,
  ignoreWhitespace?: boolean,
) {
  return ["checkoutDiff", serverId, cwd, mode, baseRef ?? "", ignoreWhitespace === true] as const;
}

interface UseCheckoutDiffQueryOptions {
  serverId: string;
  cwd: string;
  mode: "uncommitted" | "base";
  baseRef?: string;
  ignoreWhitespace?: boolean;
  enabled?: boolean;
}

type CheckoutDiffQueryPayload = Omit<SubscribeCheckoutDiffResponse["payload"], "subscriptionId">;

export type ParsedDiffFile = CheckoutDiffQueryPayload["files"][number];
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
}: UseCheckoutDiffQueryOptions) {
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const isMobile = useIsCompactFormFactor();
  const mobileView = usePanelStore((state) => state.mobileView);
  const desktopFileExplorerOpen = usePanelStore((state) => state.desktop.fileExplorerOpen);
  const explorerTab = usePanelStore((state) => state.explorerTab);
  const isOpen = isMobile ? mobileView === "file-explorer" : desktopFileExplorerOpen;
  const hookInstanceId = useId();
  const normalizedCompare = useMemo(
    () => normalizeCheckoutDiffCompare({ mode, baseRef, ignoreWhitespace }),
    [mode, baseRef, ignoreWhitespace],
  );
  const compareMode = normalizedCompare.mode;
  const compareBaseRef = normalizedCompare.baseRef;
  const compareIgnoreWhitespace = normalizedCompare.ignoreWhitespace;
  const queryKey = useMemo(
    () => checkoutDiffQueryKey(serverId, cwd, mode, baseRef, compareIgnoreWhitespace),
    [serverId, cwd, mode, baseRef, compareIgnoreWhitespace],
  );

  const query = useQuery<CheckoutDiffQueryPayload>({
    queryKey,
    queryFn: skipToken,
    staleTime: Infinity,
  });

  useEffect(() => {
    if (!client || !isConnected || !cwd || !enabled) {
      return;
    }
    if (!isOpen || explorerTab !== "changes") {
      return;
    }

    const subscriptionId = [
      "checkoutDiff",
      hookInstanceId,
      serverId,
      cwd,
      compareMode,
      compareBaseRef ?? "",
      compareIgnoreWhitespace ? "ignore-ws" : "keep-ws",
    ].join(":");
    let cancelled = false;

    const unsubscribeUpdate = client.on("checkout_diff_update", (message) => {
      if (message.payload.subscriptionId !== subscriptionId) {
        return;
      }
      queryClient.setQueryData<CheckoutDiffQueryPayload>(queryKey, {
        cwd: message.payload.cwd,
        files: orderCheckoutDiffFiles(message.payload.files),
        error: message.payload.error,
        requestId: `subscription:${subscriptionId}`,
      });
    });
    const unsubscribeSubscribeResponse = client.on(
      "subscribe_checkout_diff_response",
      (message) => {
        if (message.payload.subscriptionId !== subscriptionId) {
          return;
        }
        queryClient.setQueryData<CheckoutDiffQueryPayload>(queryKey, {
          cwd: message.payload.cwd,
          files: orderCheckoutDiffFiles(message.payload.files),
          error: message.payload.error,
          requestId: message.payload.requestId,
        });
      },
    );

    void client
      .subscribeCheckoutDiff(
        cwd,
        {
          mode: compareMode,
          baseRef: compareBaseRef,
          ignoreWhitespace: compareIgnoreWhitespace,
        },
        { subscriptionId },
      )
      .then((payload) => {
        if (cancelled) {
          return;
        }
        queryClient.setQueryData<CheckoutDiffQueryPayload>(queryKey, {
          cwd: payload.cwd,
          files: orderCheckoutDiffFiles(payload.files),
          error: payload.error,
          requestId: payload.requestId,
        });
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        console.error("[useCheckoutDiffQuery] subscribeCheckoutDiff failed", {
          serverId,
          cwd,
          error,
        });
      });

    return () => {
      cancelled = true;
      unsubscribeUpdate();
      unsubscribeSubscribeResponse();
      try {
        client.unsubscribeCheckoutDiff(subscriptionId);
      } catch {
        // Ignore disconnect race during effect cleanup.
      }
    };
  }, [
    client,
    isConnected,
    cwd,
    enabled,
    isOpen,
    explorerTab,
    hookInstanceId,
    serverId,
    compareMode,
    compareBaseRef,
    compareIgnoreWhitespace,
    queryKey,
    queryClient,
  ]);

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
