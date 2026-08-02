import { useEffect, useState } from "react";
import type { LoopLogEntry } from "@getpaseo/protocol/loop/rpc-schemas";
import { useSessionStore } from "@/stores/session-store";

function formatLoopLogEntry(entry: LoopLogEntry): string {
  const prefix = [
    entry.timestamp,
    entry.source,
    entry.iteration === null ? null : `iteration=${entry.iteration}`,
    entry.level === "error" ? "ERROR" : null,
  ]
    .filter(Boolean)
    .join(" ");
  return `${prefix}\n${entry.text}`;
}

export function useLoopLogs(input: { serverId: string; loopId: string; isPaneFocused: boolean }): {
  text: string;
  error: string | null;
  loading: boolean;
} {
  const client = useSessionStore((state) => state.sessions[input.serverId]?.client ?? null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { isPaneFocused, loopId } = input;

  useEffect(() => {
    if (!client || !isPaneFocused) {
      return;
    }
    let cancelled = false;
    let cursor = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setText("");
    setError(null);
    setLoading(true);

    const poll = async () => {
      try {
        const payload = await client.loopLogs(loopId, cursor);
        if (cancelled) return;
        if (payload.error) {
          setError(payload.error);
          setLoading(false);
          return;
        }
        setError(null);
        if (payload.entries.length > 0) {
          const chunk = payload.entries.map(formatLoopLogEntry).join("\n");
          setText((current) => (current.length > 0 ? `${current}\n${chunk}` : chunk));
        }
        cursor = payload.nextCursor;
        setLoading(false);
        if (payload.loop?.status === "running") {
          timer = setTimeout(() => {
            void poll();
          }, 1000);
        }
      } catch (err: unknown) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    };

    void poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [client, isPaneFocused, loopId]);

  return { text, error, loading };
}
