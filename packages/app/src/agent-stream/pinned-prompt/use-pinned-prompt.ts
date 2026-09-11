import { useEffect, useMemo, useRef, useState } from "react";
import { useStableEvent } from "@/hooks/use-stable-event";
import type { StreamItem } from "@/types/stream";
import { createReadingSignal, type ReadingSignalSource } from "../reading-signal";
import { resolvePinnedPrompt, type PinnedPromptResolution } from "./model";

export interface UsePinnedPromptInput {
  agentId: string;
  timelineEpoch: string | null;
  history: StreamItem[];
  liveHead: StreamItem[];
}

export interface PinnedPromptState {
  pinnedId: ReadingSignalSource<string | null>;
  promptById: ReadonlyMap<string, PinnedPromptResolution>;
  reportReadingPosition: (rowId: string | null) => void;
}

export function usePinnedPrompt({
  agentId,
  timelineEpoch,
  history,
  liveHead,
}: UsePinnedPromptInput): PinnedPromptState {
  const [pinnedId] = useState(() => createReadingSignal<string | null>(null));
  const readingRowIdRef = useRef<string | null>(null);
  const items = useMemo(() => [...history, ...liveHead], [history, liveHead]);

  // Only the id travels through the signal. The overlay looks the text up from `promptById`, which
  // changes when the timeline does rather than on every scroll frame.
  const publishPinnedPrompt = useStableEvent(() => {
    const resolution = resolvePinnedPrompt({ items, readingRowId: readingRowIdRef.current });
    pinnedId.publish(resolution?.id ?? null);
  });

  const reportReadingPosition = useStableEvent((rowId: string | null) => {
    readingRowIdRef.current = rowId;
    publishPinnedPrompt();
  });

  useEffect(() => {
    readingRowIdRef.current = null;
    pinnedId.publish(null);
  }, [agentId, pinnedId, timelineEpoch]);

  // The transcript reports its reading position before the items arrive, and a reader who never
  // scrolls would otherwise never get a pin.
  useEffect(() => {
    publishPinnedPrompt();
  }, [items, publishPinnedPrompt]);

  const promptById = useMemo(() => {
    const byId = new Map<string, PinnedPromptResolution>();
    for (const item of items) {
      if (item.kind !== "user_message") {
        continue;
      }
      const text = item.text.trim();
      if (text.length > 0) {
        byId.set(item.id, { id: item.id, text });
      }
    }
    return byId;
  }, [items]);

  return { pinnedId, promptById, reportReadingPosition };
}
