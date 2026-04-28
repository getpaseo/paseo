import { useCallback, useEffect, useState } from "react";

/**
 * Module-level store for "is this item expanded?" across remounts.
 *
 * Why this exists: the agent stream uses `FlatList` with virtualization
 * (`windowSize`, `initialNumToRender`), so off-screen items unmount. If the
 * expand/collapse state lives in component-local `useState`, a user expands
 * a tool-call block, the agent keeps streaming new events, the block scrolls
 * out of the window, unmounts, then scrolls back into view — and snaps shut.
 * (Paseo 0.1.60: "Tool call blocks expand correctly on mobile while an agent
 * is still streaming.")
 *
 * Keyed by a stable `id` (typically the timeline item id). Items without an
 * id fall back to unkeyed — state still held locally for them.
 */

const expanded = new Set<string>();
const listeners = new Map<string, Set<() => void>>();

function subscribe(id: string, listener: () => void): () => void {
  let set = listeners.get(id);
  if (!set) {
    set = new Set();
    listeners.set(id, set);
  }
  set.add(listener);
  return () => {
    const current = listeners.get(id);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(id);
  };
}

function notify(id: string): void {
  const set = listeners.get(id);
  if (!set) return;
  for (const listener of set) listener();
}

/**
 * Persistent expand/collapse state keyed by `id`. When `id` is null the hook
 * falls back to local component state (useful for cards without a stable key).
 */
export function useExpandedItemState(id: string | null): [boolean, () => void] {
  const [localIsExpanded, setLocalIsExpanded] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!id) return;
    return subscribe(id, () => setVersion((v) => v + 1));
  }, [id]);

  const isExpanded = id ? expanded.has(id) : localIsExpanded;

  const toggle = useCallback(() => {
    if (!id) {
      setLocalIsExpanded((v) => !v);
      return;
    }
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    notify(id);
  }, [id]);

  // `version` is read to keep the subscribed hook re-rendering when state
  // flips — the compiler would otherwise elide the dependency.
  void version;

  return [isExpanded, toggle];
}
