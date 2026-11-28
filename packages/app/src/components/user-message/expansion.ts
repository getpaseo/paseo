type Listener = () => void;

/**
 * Which of one agent's long user messages the user expanded past the preview. It lives with the
 * timeline, not the row, so a row that remounts (a virtualized row coming back into view, a row
 * reassigned to another list container) paints the choice the user made. A toggle notifies only
 * that message's subscribers.
 */
export function createUserMessageExpansion() {
  const expanded = new Set<string>();
  const listeners = new Map<string, Set<Listener>>();
  return {
    isExpanded: (itemId: string) => expanded.has(itemId),
    subscribe(itemId: string, listener: Listener) {
      let itemListeners = listeners.get(itemId);
      if (!itemListeners) {
        itemListeners = new Set();
        listeners.set(itemId, itemListeners);
      }
      itemListeners.add(listener);
      return () => {
        itemListeners.delete(listener);
        if (itemListeners.size === 0) listeners.delete(itemId);
      };
    },
    toggle(itemId: string) {
      if (expanded.has(itemId)) expanded.delete(itemId);
      else expanded.add(itemId);
      for (const listener of listeners.get(itemId) ?? []) listener();
    },
  };
}

export type UserMessageExpansion = ReturnType<typeof createUserMessageExpansion>;
