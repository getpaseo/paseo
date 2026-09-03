import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StreamLayoutItem } from "@/agent-stream/layout";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { getFindHighlights } from "@/find/dom/highlights.web";
import { useFindSurface } from "@/find/use-find-surface";
import { createTranscriptFindEngine } from "./engine.web";
import type { TranscriptFindItem } from "./index";
import type { UseTranscriptFindInput, UseTranscriptFindResult } from "./use-transcript-find";

/**
 * Wires the transcript's find bar to a stream-item engine.
 *
 * The engine is created only once the web viewport has published its handle, because
 * it needs the scroll element to seed, reveal and center matches. That handle object
 * is replaced whenever its callbacks change identity, so readiness is reported by the
 * viewport itself rather than polled.
 */
export function useTranscriptFind({
  history,
  liveHead,
  viewportRef,
  getRoot,
}: UseTranscriptFindInput): UseTranscriptFindResult {
  const isPanelActive = useRetainedPanelActive();
  const [isViewportReady, setIsViewportReady] = useState(false);

  const items = useMemo(() => toFindItems(history, liveHead), [history, liveHead]);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const getItems = useCallback(() => itemsRef.current, []);
  const getViewport = useCallback(() => viewportRef.current, [viewportRef]);

  const engine = useMemo(
    () =>
      isViewportReady
        ? createTranscriptFindEngine({ getItems, getViewport, highlights: getFindHighlights() })
        : null,
    [getItems, getViewport, isViewportReady],
  );
  useEffect(() => () => engine?.dispose(), [engine]);

  const surface = useFindSurface({
    name: "transcript",
    engine,
    enabled: isPanelActive && isViewportReady,
    getRoot,
  });

  const { isOpen } = surface;
  useEffect(() => {
    if (isOpen) {
      engine?.refreshItems();
    }
  }, [engine, isOpen, items]);

  const onViewportReady = useCallback((ready: boolean) => setIsViewportReady(ready), []);

  return {
    isOpen,
    query: surface.query,
    result: surface.result,
    setQuery: surface.setQuery,
    next: surface.next,
    previous: surface.previous,
    close: surface.close,
    inputRef: surface.inputRef,
    onViewportReady,
  };
}

/**
 * A streaming assistant message is excluded: the paced reveal has painted only a
 * prefix of its text, so counting the rest would report matches with nowhere to go.
 * The counter grows when the turn finishes, which is the documented behavior.
 */
function toFindItems(
  history: readonly StreamLayoutItem[],
  liveHead: readonly StreamLayoutItem[],
): TranscriptFindItem[] {
  const findItems: TranscriptFindItem[] = [];
  for (const layoutItem of history) {
    findItems.push(toFindItem(layoutItem));
  }
  for (const layoutItem of liveHead) {
    findItems.push(toFindItem(layoutItem));
  }
  return findItems;
}

function toFindItem(layoutItem: StreamLayoutItem): TranscriptFindItem {
  return {
    item: layoutItem.item,
    isStreaming: layoutItem.phase === "streaming" && layoutItem.item.kind === "assistant_message",
  };
}
