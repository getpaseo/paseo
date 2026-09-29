import { useCallback, useMemo, useState } from "react";

const INITIAL_VISIBLE_ITEMS = 20;

/** `isPinned` keeps an item visible past the cut, so the open workspace never hides. */
export function useLimitedSidebarGroup<T>(items: readonly T[], isPinned?: (item: T) => boolean) {
  const [expanded, setExpanded] = useState(false);
  const visibleItems = useMemo(() => {
    if (expanded) return items.slice();
    const head = items.slice(0, INITIAL_VISIBLE_ITEMS);
    const pinned = isPinned ? items.slice(INITIAL_VISIBLE_ITEMS).filter(isPinned) : [];
    return [...head, ...pinned];
  }, [expanded, isPinned, items]);
  const canToggle = items.length > INITIAL_VISIBLE_ITEMS;
  const toggleExpanded = useCallback(() => setExpanded((current) => !current), []);

  return { visibleItems, expanded, canToggle, toggleExpanded };
}
