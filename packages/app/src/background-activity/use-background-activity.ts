import { useCallback, useEffect, useState } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useSessionStore } from "@/stores/session-store";

type Snapshot = Awaited<ReturnType<DaemonClient["getBackgroundActivity"]>>;
let subscriptionCounter = 0;

export function useBackgroundActivity(serverId: string, conversationId?: string) {
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.backgroundActivity === true,
  );
  const [retryVersion, setRetryVersion] = useState(0);
  const retry = useCallback(() => setRetryVersion((value) => value + 1), []);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    setSnapshot(null);
    setError(null);
    if (!client || !supported) return;
    const subscriptionId = `background-${++subscriptionCounter}`;
    let disposed = false;
    let running = false;
    let dirty = false;
    let epoch: string | undefined;
    let retentionId: string | undefined;
    let afterSeq = 0;
    let rows: Snapshot["rows"] = [];
    const refresh = async () => {
      dirty = true;
      if (running) return;
      running = true;
      try {
        while (dirty) {
          if (disposed) return;
          dirty = false;
          const next = await client.getBackgroundActivity(conversationId, afterSeq);
          if (disposed) return;
          const reset =
            (epoch && epoch !== next.epoch) ||
            (retentionId && retentionId !== next.conversation?.retentionId);
          if (reset) {
            afterSeq = 0;
            rows = [];
            dirty = true;
          }
          epoch = next.epoch;
          retentionId = next.conversation?.retentionId;
          if (reset) continue;
          for (const row of next.rows) {
            if (row.seq > afterSeq) {
              rows.push(row);
              afterSeq = row.seq;
            }
          }
          if (!next.conversation) rows = [];
          setSnapshot({ ...next, rows: [...rows] });
          setError(null);
          if (next.hasMore) dirty = true;
        }
      } catch (failure) {
        if (!disposed) setError(String(failure));
      } finally {
        running = false;
      }
    };
    const stopMessages = client.subscribeRawMessages((message) => {
      if (
        message.type === "background.activity.changed" &&
        message.payload.subscriptionId === subscriptionId
      )
        void refresh();
    });
    const stopConnection = client.subscribeConnectionStatus((state) => {
      setConnected(state.status === "connected");
      if (state.status !== "connected") return;
      void client
        .setBackgroundActivitySubscription(subscriptionId, true, conversationId)
        .then(refresh)
        .catch((failure: unknown) => {
          if (!disposed) setError(String(failure));
        });
    });
    return () => {
      disposed = true;
      stopMessages();
      stopConnection();
      if (client.isConnected)
        void client.setBackgroundActivitySubscription(subscriptionId, false).catch(() => undefined);
    };
  }, [client, supported, conversationId, retryVersion]);
  return { snapshot, error, supported, connected, retry };
}
