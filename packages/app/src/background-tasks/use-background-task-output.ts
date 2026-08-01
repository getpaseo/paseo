import { useEffect, useState } from "react";
import { useSessionStore } from "@/stores/session-store";

export function shouldSubscribeToBackgroundTaskOutput(input: {
  supported: boolean;
  isPaneFocused: boolean;
}): boolean {
  return input.supported && input.isPaneFocused;
}

export function useBackgroundTaskOutput(input: {
  serverId: string;
  parentAgentId: string;
  taskId: string;
  supported: boolean;
  isPaneFocused: boolean;
}): { text: string; error: string | null; loading: boolean } {
  const client = useSessionStore((state) => state.sessions[input.serverId]?.client ?? null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { isPaneFocused, parentAgentId, supported, taskId } = input;

  useEffect(() => {
    if (!client || !shouldSubscribeToBackgroundTaskOutput({ supported, isPaneFocused })) {
      return;
    }
    let cancelled = false;
    let cursor = 0;
    setLoading(true);

    const appendChunk = (chunk: string, nextCursor: number) => {
      if (cancelled) return;
      cursor = nextCursor;
      if (chunk.length > 0) {
        setText((current) => `${current}${chunk}`);
      }
    };

    void client
      .getBackgroundTaskOutput(parentAgentId, taskId, { cursor: 0, maxBytes: 64_000 })
      .then((payload) => {
        if (cancelled) return undefined;
        setError(payload.error);
        setText(payload.text);
        cursor = payload.nextCursor;
        return undefined;
      })
      .catch((err: unknown) => {
        if (cancelled) return undefined;
        setError(err instanceof Error ? err.message : String(err));
        return undefined;
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    void client.subscribeBackgroundTaskOutput(parentAgentId, taskId).catch(() => undefined);

    const unsubscribe = client.on("agent.background_tasks.output.update", (message) => {
      if (message.type !== "agent.background_tasks.output.update") return;
      if (message.payload.parentAgentId !== parentAgentId || message.payload.taskId !== taskId) {
        return;
      }
      if (message.payload.nextCursor < cursor) return;
      appendChunk(message.payload.text, message.payload.nextCursor);
    });

    return () => {
      cancelled = true;
      unsubscribe();
      void client.unsubscribeBackgroundTaskOutput(parentAgentId, taskId).catch(() => undefined);
    };
  }, [client, isPaneFocused, parentAgentId, supported, taskId]);

  return { text, error, loading };
}
