import { useCallback, useSyncExternalStore } from "react";

/**
 * Which embedded timeline has the user's focus. An embed is not a workspace pane, so nothing else
 * decides it: the embed the user last touched, clicked or tabbed into owns the composer's key
 * handlers (Escape interrupts, send, mode cycling, find), and every other embed gives them up.
 */
let focusedEmbedId: string | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function focusEmbed(embedId: string): void {
  if (focusedEmbedId === embedId) return;
  focusedEmbedId = embedId;
  for (const listener of listeners) listener();
}

export function blurEmbed(embedId: string): void {
  if (focusedEmbedId !== embedId) return;
  focusedEmbedId = null;
  for (const listener of listeners) listener();
}

export function useIsEmbedFocused(embedId: string): boolean {
  const read = useCallback(() => focusedEmbedId === embedId, [embedId]);
  return useSyncExternalStore(subscribe, read, read);
}
