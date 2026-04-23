import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  EmbeddingProvider,
  ExposeToEntry,
  IndexingState,
} from "@server/server/indexing/types";
import type { IndexingToolDetection } from "@server/server/indexing/detector";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

export interface CrgProcessState {
  phase: "stopped" | "starting" | "running" | "restarting" | "failed";
  pid?: number;
  startedAt?: number;
  restartCount: number;
  lastError?: string;
}

export interface FsTriggerInfo {
  workspaceId: string;
  kind: "change" | "error";
  at: number;
  changedPaths?: string[];
  error?: string;
}

export interface IndexingWorkspaceEntry {
  workspaceId: string;
  indexing?: IndexingState;
}

export function indexingListQueryKey(serverId: string | null) {
  return ["indexing", "list", serverId] as const;
}

export function indexingDetectQueryKey(serverId: string | null) {
  return ["indexing", "detect", serverId] as const;
}

export function indexingToolsQueryKey(serverId: string | null) {
  return ["indexing", "tools", serverId] as const;
}

export interface UseIndexingResult {
  isConnected: boolean;
  entries: IndexingWorkspaceEntry[];
  detection: IndexingToolDetection | null;
  isLoading: boolean;
  refetch: () => Promise<void>;
  setEnabled: (workspaceId: string, enabled: boolean) => Promise<IndexingState | null>;
  setExposeTo: (
    workspaceId: string,
    agentId: string,
    entry: ExposeToEntry | null,
  ) => Promise<IndexingState | null>;
  setEmbeddingProvider: (
    workspaceId: string,
    provider: EmbeddingProvider | null,
  ) => Promise<IndexingState | null>;
  setWatchlist: (workspaceId: string, watchlist: string[]) => Promise<IndexingState | null>;
  redetect: () => Promise<IndexingToolDetection | null>;
  install: (onEvent: (event: unknown) => void) => Promise<{ success: boolean; error?: string }>;
  reindex: (workspaceId: string) => Promise<IndexingState | null>;
  crgTools: Array<{ name: string; description?: string }>;
  isToolsLoading: boolean;
  refreshTools: () => Promise<void>;
  processState: CrgProcessState | null;
  lastFsTrigger: FsTriggerInfo | null;
}

export function useIndexing(serverId: string | null): UseIndexingResult {
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const listKey = useMemo(() => indexingListQueryKey(serverId), [serverId]);
  const detectKey = useMemo(() => indexingDetectQueryKey(serverId), [serverId]);
  const toolsKey = useMemo(() => indexingToolsQueryKey(serverId), [serverId]);

  const listQuery = useQuery({
    queryKey: listKey,
    enabled: Boolean(serverId && client && isConnected),
    staleTime: 5_000,
    queryFn: async () => {
      if (!client) throw new Error("Host is not connected");
      const result = await client.indexingList();
      if (result.error) throw new Error(result.error);
      return result.entries;
    },
  });

  const detectQuery = useQuery({
    queryKey: detectKey,
    enabled: Boolean(serverId && client && isConnected),
    staleTime: 30_000,
    queryFn: async () => {
      if (!client) throw new Error("Host is not connected");
      const result = await client.indexingDetect();
      if (result.error) throw new Error(result.error);
      return result.detection;
    },
  });

  const toolsQuery = useQuery({
    queryKey: toolsKey,
    enabled: Boolean(serverId && client && isConnected),
    staleTime: 60_000,
    queryFn: async () => {
      if (!client) throw new Error("Host is not connected");
      const result = await client.indexingToolsList();
      if (result.error) throw new Error(result.error);
      return result.tools;
    },
  });

  // Subscribe to push status updates so the list reflects live progress.
  useEffect(() => {
    if (!client || !isConnected || !serverId) return;
    return client.on("status", (msg) => {
      if (msg.type !== "indexing/status") return;
      queryClient.setQueryData<IndexingWorkspaceEntry[]>(listKey, (prev) => {
        if (!prev) return prev;
        return prev.map((entry) => {
          if (entry.workspaceId !== msg.payload.workspaceId) return entry;
          if (!entry.indexing) return entry;
          return {
            ...entry,
            indexing: { ...entry.indexing, status: msg.payload.status },
          };
        });
      });
    });
  }, [client, isConnected, serverId, listKey, queryClient]);

  // crg subprocess state push — visible as a small health badge in the UI.
  const [processState, setProcessState] = useState<CrgProcessState | null>(null);
  useEffect(() => {
    if (!client || !isConnected || !serverId) return;
    return client.on("status", (msg) => {
      if (msg.type !== "indexing/process-state") return;
      setProcessState(msg.payload as CrgProcessState);
    });
  }, [client, isConnected, serverId]);

  // tool-list refresh push — invalidate the cached tools query so the UI
  // picks up freshly-installed / removed crg tools without the staleTime
  // cooldown.
  useEffect(() => {
    if (!client || !isConnected || !serverId) return;
    return client.on("status", (msg) => {
      if (msg.type !== "indexing/tools-changed") return;
      void queryClient.invalidateQueries({ queryKey: toolsKey });
    });
  }, [client, isConnected, serverId, toolsKey, queryClient]);

  // fs-watcher events — keep only the latest so the UI can show "reindex
  // triggered by N files (Xs ago)" without unbounded growth.
  const [lastFsTrigger, setLastFsTrigger] = useState<FsTriggerInfo | null>(null);
  useEffect(() => {
    if (!client || !isConnected || !serverId) return;
    return client.on("status", (msg) => {
      if (msg.type !== "indexing/fs-trigger") return;
      const p = msg.payload as
        | { kind: "change"; workspaceId: string; changedPaths: string[] }
        | { kind: "error"; workspaceId: string; error: string };
      setLastFsTrigger({
        workspaceId: p.workspaceId,
        kind: p.kind,
        at: Date.now(),
        ...(p.kind === "change" ? { changedPaths: p.changedPaths } : { error: p.error }),
      });
    });
  }, [client, isConnected, serverId]);

  const refetch = useCallback(async () => {
    await Promise.all([listQuery.refetch(), detectQuery.refetch()]);
  }, [listQuery, detectQuery]);

  const setEnabled = useCallback(
    async (workspaceId: string, enabled: boolean) => {
      if (!client) return null;
      const result = await client.indexingSetEnabled(workspaceId, enabled);
      await listQuery.refetch();
      return result.indexing;
    },
    [client, listQuery],
  );

  const setExposeTo = useCallback(
    async (workspaceId: string, agentId: string, entry: ExposeToEntry | null) => {
      if (!client) return null;
      const result = await client.indexingSetExposeTo(workspaceId, agentId, entry);
      await listQuery.refetch();
      return result.indexing;
    },
    [client, listQuery],
  );

  const setEmbeddingProvider = useCallback(
    async (workspaceId: string, provider: EmbeddingProvider | null) => {
      if (!client) return null;
      const result = await client.indexingSetEmbeddingProvider(workspaceId, provider);
      await listQuery.refetch();
      return result.indexing;
    },
    [client, listQuery],
  );

  const setWatchlist = useCallback(
    async (workspaceId: string, watchlist: string[]) => {
      if (!client) return null;
      const result = await client.indexingSetWatchlist(workspaceId, watchlist);
      await listQuery.refetch();
      return result.indexing;
    },
    [client, listQuery],
  );

  const redetect = useCallback(async () => {
    if (!client) return null;
    const result = await client.indexingDetect({ force: true });
    queryClient.setQueryData(detectKey, result.detection);
    return result.detection;
  }, [client, queryClient, detectKey]);

  const install = useCallback(
    async (onEvent: (event: unknown) => void) => {
      if (!client) return { success: false, error: "not connected" };
      const outcome = await client.indexingInstall(onEvent);
      await Promise.all([listQuery.refetch(), detectQuery.refetch(), toolsQuery.refetch()]);
      return outcome;
    },
    [client, listQuery, detectQuery, toolsQuery],
  );

  const refreshTools = useCallback(async () => {
    await toolsQuery.refetch();
  }, [toolsQuery]);

  const reindex = useCallback(
    async (workspaceId: string) => {
      if (!client) return null;
      const result = await client.indexingReindex(workspaceId);
      await listQuery.refetch();
      return result.indexing;
    },
    [client, listQuery],
  );

  return {
    isConnected,
    entries: listQuery.data ?? [],
    detection: detectQuery.data ?? null,
    isLoading: listQuery.isLoading || detectQuery.isLoading,
    refetch,
    setEnabled,
    setExposeTo,
    setEmbeddingProvider,
    setWatchlist,
    redetect,
    install,
    reindex,
    crgTools: toolsQuery.data ?? [],
    isToolsLoading: toolsQuery.isLoading,
    refreshTools,
    processState,
    lastFsTrigger,
  };
}
