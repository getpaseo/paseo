import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type {
  CheckoutDiffGetImageRequest,
  CheckoutDiffGetImageResponse,
} from "@getpaseo/protocol/messages";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { checkoutImageDiffQueryKey } from "@/git/query-keys";

export interface UseImageDiffQueryOptions {
  serverId: string;
  cwd: string;
  path: string;
  oldPath?: string;
  mode: "uncommitted" | "base";
  baseRef?: string;
  enabled: boolean;
}

export type ImageDiffPayload = CheckoutDiffGetImageResponse["payload"];

export function useImageDiffQuery({
  serverId,
  cwd,
  path,
  oldPath,
  mode,
  baseRef,
  enabled,
}: UseImageDiffQueryOptions) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const compare = useMemo<CheckoutDiffGetImageRequest["compare"]>(
    () => ({
      mode,
      ...(mode === "base" && baseRef?.trim() ? { baseRef: baseRef.trim() } : {}),
    }),
    [baseRef, mode],
  );
  const queryKey = checkoutImageDiffQueryKey({
    serverId,
    cwd,
    path,
    oldPath,
    mode: compare.mode,
    baseRef: compare.baseRef,
  });
  const canLoad = enabled && Boolean(client) && isConnected && cwd.length > 0 && path.length > 0;

  return useFetchQuery<ImageDiffPayload>({
    queryKey,
    queryFn: () => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      return client.checkoutGetImageDiff(cwd, {
        path,
        ...(oldPath ? { oldPath } : {}),
        compare,
      });
    },
    enabled: canLoad,
    dataShape: "value",
    staleTimeMs: 30_000,
  });
}
