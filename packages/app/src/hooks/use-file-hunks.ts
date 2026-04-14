import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { ParsedDiffFile } from "@/hooks/use-checkout-diff-query";
import type { DiffFileMetadata } from "@/hooks/use-checkout-diff-metadata-query";

function fileHunksQueryKey(
  serverId: string,
  cwd: string,
  mode: "uncommitted" | "base",
  baseRef: string | undefined,
  ignoreWhitespace: boolean | undefined,
  path: string,
  fingerprint: string,
) {
  return [
    "checkoutFileHunks",
    serverId,
    cwd,
    mode,
    baseRef ?? "",
    ignoreWhitespace === true,
    path,
    fingerprint,
  ] as const;
}

interface UseFileHunksOptions {
  serverId: string;
  cwd: string;
  mode: "uncommitted" | "base";
  baseRef?: string;
  ignoreWhitespace?: boolean;
  file: DiffFileMetadata;
  enabled?: boolean;
}

export function useFileHunks({
  serverId,
  cwd,
  mode,
  baseRef,
  ignoreWhitespace,
  file,
  enabled = true,
}: UseFileHunksOptions) {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);

  const queryKey = useMemo(
    () =>
      fileHunksQueryKey(
        serverId,
        cwd,
        mode,
        baseRef,
        ignoreWhitespace,
        file.path,
        file.fingerprint,
      ),
    [serverId, cwd, mode, baseRef, ignoreWhitespace, file.path, file.fingerprint],
  );

  const query = useQuery({
    queryKey,
    queryFn: async (): Promise<ParsedDiffFile> => {
      if (!client) {
        throw new Error("Daemon client not available");
      }
      const payload = await client.getCheckoutFileHunks(
        cwd,
        { mode, baseRef, ignoreWhitespace },
        file.path,
      );
      if (payload.error) {
        throw new Error(payload.error.message);
      }
      return {
        path: file.path,
        isNew: file.isNew,
        isDeleted: file.isDeleted,
        additions: file.additions,
        deletions: file.deletions,
        status: file.status,
        hunks: payload.hunks,
      };
    },
    enabled: !!client && isConnected && enabled,
    staleTime: 60_000,
  });

  return {
    file: query.data ?? null,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
  };
}
