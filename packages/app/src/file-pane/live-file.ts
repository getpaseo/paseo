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
  const queryKey = useMemo(
    () => ["workspaceFile", input.serverId, input.cwd, input.path] as const,
    [input.cwd, input.path, input.serverId],
  );

  useEffect(() => {
    latestVersion.current = null;
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
          latestVersion.current = next;
          setVersion(next);
          void queryClient.invalidateQueries({ queryKey });
        });
        if (disposed) {
          subscription.unsubscribe();
          return;
        }
        unsubscribe = subscription.unsubscribe;
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

  return { query, version };
}
