import { useCallback, useRef } from "react";
import { useRetainedPanelActive } from "@/components/retained-panel";

/**
 * Whether the composer's input is on screen, as a read a saved plugin command can make later. A
 * retained composer keeps its input mounted and hidden, and its cursor and selection are then
 * stale, so only an input in a panel that is showing counts.
 */
export function useIsInputLive(input: { readonly current: unknown }): () => boolean {
  const panelActive = useRetainedPanelActive();
  const panelActiveRef = useRef(panelActive);
  panelActiveRef.current = panelActive;
  return useCallback(() => input.current !== null && panelActiveRef.current, [input]);
}
