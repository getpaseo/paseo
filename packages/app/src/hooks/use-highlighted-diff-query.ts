import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import { UnistylesRuntime } from "react-native-unistyles";
import { useSessionStore } from "@/stores/session-store";
import { usePanelStore } from "@/stores/panel-store";
import type { HighlightedDiffResponse } from "@server/shared/messages";
import { getNowMs, isPerfLoggingEnabled, measurePayload, perfLog } from "@/utils/perf";

const HIGHLIGHTED_DIFF_STALE_TIME = 30_000;
const HIGHLIGHTED_DIFF_LOG_TAG = "[HighlightedDiff]";

function highlightedDiffQueryKey(serverId: string, agentId: string) {
  return ["highlightedDiff", serverId, agentId] as const;
}

interface UseHighlightedDiffQueryOptions {
  serverId: string;
  agentId: string;
}

export type ParsedDiffFile = HighlightedDiffResponse["payload"]["files"][number];
export type DiffHunk = ParsedDiffFile["hunks"][number];
export type DiffLine = DiffHunk["lines"][number];
export type HighlightToken = NonNullable<DiffLine["tokens"]>[number];

export function useHighlightedDiffQuery({ serverId, agentId }: UseHighlightedDiffQueryOptions) {
  const queryClient = useQueryClient();
  const client = useSessionStore(
    (state) => state.sessions[serverId]?.client ?? null
  );
  const isConnected = useSessionStore(
    (state) => state.sessions[serverId]?.connection.isConnected ?? false
  );
  const isMobile =
    UnistylesRuntime.breakpoint === "xs" || UnistylesRuntime.breakpoint === "sm";
  const mobileView = usePanelStore((state) => state.mobileView);
  const desktopFileExplorerOpen = usePanelStore((state) => state.desktop.fileExplorerOpen);
  const explorerTab = usePanelStore((state) => state.explorerTab);
  const isOpen = isMobile ? mobileView === "file-explorer" : desktopFileExplorerOpen;

  const query = useQuery({
    queryKey: highlightedDiffQueryKey(serverId, agentId),
    queryFn: async () => {
      if (!client) {
        throw new Error("Daemon client not available");
      }
      const shouldLog = isPerfLoggingEnabled();
      const startMs = shouldLog ? getNowMs() : 0;
      const response = await client.getHighlightedDiff(agentId);
      if (shouldLog) {
        let hunkCount = 0;
        let lineCount = 0;
        let tokenCount = 0;
        for (const file of response.files) {
          hunkCount += file.hunks.length;
          for (const hunk of file.hunks) {
            lineCount += hunk.lines.length;
            for (const line of hunk.lines) {
              if (line.tokens) {
                tokenCount += line.tokens.length;
              }
            }
          }
        }
        const durationMs = getNowMs() - startMs;
        const metrics = measurePayload(response);
        perfLog(HIGHLIGHTED_DIFF_LOG_TAG, {
          event: "fetch",
          serverId,
          agentId,
          durationMs: Math.round(durationMs),
          fileCount: response.files.length,
          hunkCount,
          lineCount,
          tokenCount,
          payloadApproxBytes: metrics.approxBytes,
          payloadFieldCount: metrics.fieldCount,
        });
      }
      return response.files;
    },
    enabled: !!client && isConnected && !!agentId,
    staleTime: HIGHLIGHTED_DIFF_STALE_TIME,
    refetchInterval: 10_000,
  });

  // Revalidate when sidebar opens with "changes" tab active
  useEffect(() => {
    if (!isOpen || explorerTab !== "changes" || !agentId) {
      return;
    }
    // Invalidate to trigger background refetch (shows stale data while fetching)
    queryClient.invalidateQueries({
      queryKey: highlightedDiffQueryKey(serverId, agentId),
    });
  }, [isOpen, explorerTab, serverId, agentId, queryClient]);

  const refresh = useCallback(() => {
    return query.refetch();
  }, [query]);

  return {
    files: query.data ?? [],
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    refresh,
  };
}
