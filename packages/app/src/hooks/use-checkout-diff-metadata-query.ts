import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useMemo } from "react";
import { useIsCompactFormFactor } from "@/constants/layout";
import { usePanelStore } from "@/stores/panel-store";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { CheckoutDiffSnapshot } from "@server/shared/messages";
import { orderCheckoutDiffFiles } from "./checkout-diff-order";

const CHECKOUT_DIFF_METADATA_STALE_TIME = 30_000;

export type DiffFileMetadata = CheckoutDiffSnapshot["payload"]["files"][number];

type CheckoutDiffMetadataPayload = Omit<CheckoutDiffSnapshot["payload"], "subscriptionId">;

function checkoutDiffMetadataQueryKey(
  serverId: string,
  cwd: string,
  mode: "uncommitted" | "base",
  baseRef?: string,
  ignoreWhitespace?: boolean,
) {
  return [
    "checkoutDiffMetadata",
    serverId,
    cwd,
    mode,
    baseRef ?? "",
    ignoreWhitespace === true,
  ] as const;
}

interface UseCheckoutDiffMetadataQueryOptions {
  serverId: string;
  cwd: string;
  mode: "uncommitted" | "base";
  baseRef?: string;
  ignoreWhitespace?: boolean;
  enabled?: boolean;
}

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

export function useCheckoutDiffMetadataQuery({
  serverId,
  cwd,
  mode,
  baseRef,
  ignoreWhitespace,
  enabled = true,
}: UseCheckoutDiffMetadataQueryOptions) {
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
    () => checkoutDiffMetadataQueryKey(serverId, cwd, mode, baseRef, compareIgnoreWhitespace),
    [serverId, cwd, mode, baseRef, compareIgnoreWhitespace],
  );

  const query = useQuery({
    queryKey,
    queryFn: async () => {
      if (!client) {
        throw new Error("Daemon client not available");
      }
      const payload = await client.getCheckoutDiffMetadata(cwd, {
        mode: compareMode,
        baseRef: compareBaseRef,
        ignoreWhitespace: compareIgnoreWhitespace,
      });
      return {
        cwd: payload.cwd,
        files: orderCheckoutDiffFiles(payload.files),
        error: payload.error,
        requestId: payload.requestId,
      };
    },
    enabled: !!client && isConnected && !!cwd && enabled,
    staleTime: CHECKOUT_DIFF_METADATA_STALE_TIME,
  });

  useEffect(() => {
    if (!client || !isConnected || !cwd || !enabled) {
      return;
    }
    if (!isOpen || explorerTab !== "changes") {
      return;
    }

    const subscriptionId = [
      "checkoutDiffMetadata",
      hookInstanceId,
      serverId,
      cwd,
      compareMode,
      compareBaseRef ?? "",
      compareIgnoreWhitespace ? "ignore-ws" : "keep-ws",
    ].join(":");
    let cancelled = false;

    const unsubscribeSnapshot = client.on("checkout/diff_snapshot", (message) => {
      if (message.type !== "checkout/diff_snapshot") {
        return;
      }
      if (message.payload.subscriptionId !== subscriptionId) {
        return;
      }
      queryClient.setQueryData<CheckoutDiffMetadataPayload>(queryKey, {
        cwd: message.payload.cwd,
        files: orderCheckoutDiffFiles(message.payload.files),
        error: message.payload.error,
        requestId: message.payload.requestId,
      });
    });

    void client
      .subscribeCheckoutDiffLazy(
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
        queryClient.setQueryData<CheckoutDiffMetadataPayload>(queryKey, {
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
        console.error("[useCheckoutDiffMetadataQuery] subscribeCheckoutDiffLazy failed", {
          serverId,
          cwd,
          error,
        });
      });

    return () => {
      cancelled = true;
      unsubscribeSnapshot();
      try {
        client.unsubscribeCheckoutDiffLazy(subscriptionId);
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
