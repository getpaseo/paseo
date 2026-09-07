export type RouteHistoryDirection = "back" | "forward";

export interface RouteHistoryEntry {
  href: string;
  tabId: string | null;
}

export function normalizeRouteHistoryHref(href: string, segments: readonly string[]): string {
  const url = new URL(href, "http://paseo.local");
  // Revisiting a nested route can echo its path params into the query string.
  for (const segment of segments) {
    if (!segment.startsWith("[")) continue;
    const param = segment.replace(/^\[+(?:\.\.\.)?|\]+$/g, "");
    url.searchParams.delete(param);
  }
  url.searchParams.sort();
  return `${url.pathname}${url.search}${url.hash}`;
}

function sameEntry(a: RouteHistoryEntry | undefined, b: RouteHistoryEntry): boolean {
  return a?.href === b.href && a.tabId === b.tabId;
}

export function createRouteHistory() {
  const entries: RouteHistoryEntry[] = [];
  let index = -1;
  // Route commits can lag behind tab focus, including during repeated shortcuts.
  const replayRoutes = new Set<string>();

  return {
    record(entry: RouteHistoryEntry) {
      if (sameEntry(entries[index], entry)) {
        replayRoutes.clear();
        return;
      }
      if (replayRoutes.has(entry.href)) return;
      replayRoutes.clear();
      entries.splice(index + 1);
      entries.push(entry);
      if (entries.length > 100) entries.shift();
      index = entries.length - 1;
    },
    move(
      direction: RouteHistoryDirection,
      isAvailable: (entry: RouteHistoryEntry) => boolean,
    ): RouteHistoryEntry | null {
      const step = direction === "back" ? -1 : 1;
      for (let next = index + step; next >= 0 && next < entries.length; next += step) {
        const entry = entries[next];
        if (sameEntry(entries[index], entry) || !isAvailable(entry)) continue;
        replayRoutes.add(entries[index].href);
        replayRoutes.add(entry.href);
        index = next;
        return entry;
      }
      return null;
    },
  };
}
