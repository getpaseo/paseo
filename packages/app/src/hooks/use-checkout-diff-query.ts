import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useMemo } from "react";
import { UnistylesRuntime } from "react-native-unistyles";
import { usePanelStore } from "@/stores/panel-store";
import { useHostRuntimeSession } from "@/runtime/host-runtime";
import type { SubscribeCheckoutDiffResponse } from "@server/shared/messages";
import { orderCheckoutDiffFiles } from "./checkout-diff-order";

const CHECKOUT_DIFF_STALE_TIME = 30_000;

function checkoutDiffQueryKey(
  serverId: string,
  cwd: string,
  mode: "uncommitted" | "base",
  baseRef?: string
) {
  return ["checkoutDiff", serverId, cwd, mode, baseRef ?? ""] as const;
}

interface UseCheckoutDiffQueryOptions {
  serverId: string;
  cwd: string;
  mode: "uncommitted" | "base";
  baseRef?: string;
  enabled?: boolean;
}

type CheckoutDiffQueryPayload = Omit<
  SubscribeCheckoutDiffResponse["payload"],
  "subscriptionId"
>;

export type ParsedDiffFile = CheckoutDiffQueryPayload["files"][number];
export type DiffHunk = ParsedDiffFile["hunks"][number];
export type DiffLine = DiffHunk["lines"][number];
export type HighlightToken = NonNullable<DiffLine["tokens"]>[number];

function normalizeCheckoutDiffCompare(compare: {
  mode: "uncommitted" | "base";
  baseRef?: string;
}): { mode: "uncommitted" | "base"; baseRef?: string } {
  if (compare.mode === "uncommitted") {
    return { mode: "uncommitted" };
  }
  const trimmedBaseRef = compare.baseRef?.trim();
  return trimmedBaseRef
    ? { mode: "base", baseRef: trimmedBaseRef }
    : { mode: "base" };
}

export function useCheckoutDiffQuery({
  serverId,
  cwd,
  mode,
  baseRef,
  enabled = true,
}: UseCheckoutDiffQueryOptions) {
  const queryClient = useQueryClient();
  const { client, isConnected } = useHostRuntimeSession(serverId);
  const isMobile =
    UnistylesRuntime.breakpoint === "xs" || UnistylesRuntime.breakpoint === "sm";
  const mobileView = usePanelStore((state) => state.mobileView);
  const desktopFileExplorerOpen = usePanelStore((state) => state.desktop.fileExplorerOpen);
  const explorerTab = usePanelStore((state) => state.explorerTab);
  const isOpen = isMobile ? mobileView === "file-explorer" : desktopFileExplorerOpen;
  const hookInstanceId = useId();
  const normalizedCompare = useMemo(
    () => normalizeCheckoutDiffCompare({ mode, baseRef }),
    [mode, baseRef]
  );
  const compareMode = normalizedCompare.mode;
  const compareBaseRef = normalizedCompare.baseRef;
  const queryKey = useMemo(
    () => checkoutDiffQueryKey(serverId, cwd, mode, baseRef),
    [serverId, cwd, mode, baseRef]
  );

  const query = useQuery({
    queryKey,
    queryFn: async () => {
      if (!client) {
        throw new Error("Daemon client not available");
      }
      const payload = await client.getCheckoutDiff(cwd, {
        mode: compareMode,
        baseRef: compareBaseRef,
      });
      return {
        ...payload,
        files: orderCheckoutDiffFiles(payload.files),
      };
    },
    enabled: !!client && isConnected && !!cwd && enabled,
    staleTime: CHECKOUT_DIFF_STALE_TIME,
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
    ].join(":");
    let cancelled = false;

    const unsubscribeUpdate = client.on("checkout_diff_update", (message) => {
      if (message.type !== "checkout_diff_update") {
        return;
      }
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
        if (message.type !== "subscribe_checkout_diff_response") {
          return;
        }
        if (message.payload.subscriptionId !== subscriptionId) {
          return;
        }
        queryClient.setQueryData<CheckoutDiffQueryPayload>(queryKey, {
          cwd: message.payload.cwd,
          files: orderCheckoutDiffFiles(message.payload.files),
          error: message.payload.error,
          requestId: message.payload.requestId,
        });
      }
    );

    void client
      .subscribeCheckoutDiff(
        cwd,
        {
          mode: compareMode,
          baseRef: compareBaseRef,
        },
        { subscriptionId }
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
    queryKey,
    queryClient,
  ]);

  const refresh = useCallback(() => {
    return query.refetch();
  }, [query]);

  const payload = query.data ?? null;
  const payloadError = payload?.error ?? null;

  return {
    files: payload?.files ?? [],
    payloadError,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError || Boolean(payloadError),
    error: query.error,
    refresh,
  };
}
