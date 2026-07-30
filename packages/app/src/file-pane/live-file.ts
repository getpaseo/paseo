import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DaemonClient, FileReadResult } from "@getpaseo/client/internal/daemon-client";
import type { FileVersion } from "@getpaseo/protocol/messages";
import { useFetchQuery } from "@/data/query";

export function useLiveFile(input: {
  client: DaemonClient | null;
  serverId: string;
  cwd: string | null;
  path: string | null;
  enabled: boolean;
  liveUpdates: boolean;
}) {
  const queryClient = useQueryClient();
  const [subscriptionReady, setSubscriptionReady] = useState(!input.liveUpdates);
  const [version, setVersion] = useState<FileVersion | null>(null);
  const latestVersion = useRef<FileVersion | null>(null);
  const latestQueryDataUpdatedAt = useRef(0);
  const nonReadyObservedAt = useRef<number | null>(null);
  const queryKey = useMemo(
    () => ["workspaceFile", input.serverId, input.cwd, input.path] as const,
    [input.cwd, input.path, input.serverId],
  );

  useEffect(() => {
    latestVersion.current = null;
    nonReadyObservedAt.current = null;
    setVersion(null);
    const { client, cwd, path } = input;
    if (!input.liveUpdates || !client || !cwd || !path || !input.enabled) {
      setSubscriptionReady(!input.liveUpdates);
      return;
    }
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    setSubscriptionReady(false);
    void (async () => {
      try {
        const subscription = await client.subscribeFile({ cwd, path }, (next) => {
          if (disposed) return;
          nonReadyObservedAt.current =
            next.status === "ready" ? null : latestQueryDataUpdatedAt.current;
          latestVersion.current = next;
          setVersion(next);
          void queryClient.invalidateQueries({ queryKey });
        });
        if (disposed) {
          subscription.unsubscribe();
          return;
        }
        unsubscribe = subscription.unsubscribe;
        nonReadyObservedAt.current =
          subscription.initial.status === "ready" ? null : latestQueryDataUpdatedAt.current;
        latestVersion.current = subscription.initial;
        setVersion(subscription.initial);
        setSubscriptionReady(true);
      } catch {
        if (!disposed) setSubscriptionReady(true);
      }
    })();
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [
    input.client,
    input.cwd,
    input.enabled,
    input.liveUpdates,
    input.path,
    queryClient,
    queryKey,
    input.serverId,
  ]);

  const query = useFetchQuery({
    queryKey,
    enabled: input.enabled && Boolean(input.client && input.cwd && input.path) && subscriptionReady,
    queryFn: async (): Promise<FileReadResult> => {
      if (!input.client || !input.cwd || !input.path) throw new Error("File unavailable.");
      return input.client.readFile(input.cwd, input.path);
    },
    dataShape: "value",
    staleTimeMs: 5_000,
  });
  latestQueryDataUpdatedAt.current = query.dataUpdatedAt;

  useEffect(() => {
    const observed = latestVersion.current;
    if (
      query.data &&
      observed?.status === "ready" &&
      query.data.modifiedAt !== observed.modifiedAt
    ) {
      void queryClient.invalidateQueries({ queryKey });
    }
  }, [query.data, queryClient, queryKey]);

  useEffect(() => {
    if (!input.liveUpdates || !query.data || !input.cwd || !input.path) return;
    const observed = latestVersion.current;
    const observedAt = nonReadyObservedAt.current;
    if (observed?.status === "ready" || observedAt === null || query.dataUpdatedAt <= observedAt) {
      return;
    }

    const recoveredVersion: FileVersion = {
      status: "ready",
      cwd: input.cwd,
      path: input.path,
      size: query.data.size,
      modifiedAt: query.data.modifiedAt,
      revision: query.data.revision,
    };
    nonReadyObservedAt.current = null;
    latestVersion.current = recoveredVersion;
    setVersion(recoveredVersion);
  }, [input.cwd, input.liveUpdates, input.path, query.data, query.dataUpdatedAt]);

  return { query, version };
}
