const MAX_ENTRIES = 60;

/**
 * Where each file view was left scrolled.
 *
 * A file tab keeps one view per panel — the rendered page, the source, the Markdown —
 * and two of them unmount when the other takes over: switching Preview and Source
 * recreates the view that comes back, so its scroll offset would otherwise start at the
 * top. The memory is per key, oldest evicted first, and holds no content: a tab that is
 * closed and reopened long after only ever restores a position for the file it showed.
 */
const offsets = new Map<string, number>();

/** The key one file's one view is remembered under. */
export function previewScrollKey(input: {
  workspaceId: string;
  path: string;
  view: "preview" | "source";
}): string {
  return `${input.workspaceId}:${input.view}:${input.path}`;
}

export function readPreviewScroll(key: string): number {
  return offsets.get(key) ?? 0;
}

/** Keeps `offset` for `key`; 0 forgets it, so a file left at the top restores to the top. */
export function writePreviewScroll(key: string, offset: number): void {
  if (!Number.isFinite(offset) || offset <= 0) {
    offsets.delete(key);
    return;
  }
  // Re-insert so the most recently left view is the last evicted.
  offsets.delete(key);
  offsets.set(key, offset);
  while (offsets.size > MAX_ENTRIES) {
    const oldest = offsets.keys().next();
    if (oldest.done) break;
    offsets.delete(oldest.value);
  }
}

export function clearPreviewScrollMemory(): void {
  offsets.clear();
}

/**
 * Keeps a DOM scroller's offset under `key` for as long as it lives. CodeMirror owns
 * its own scroller, so the offset is read from and written to that element directly.
 */
export function rememberElementScroll(element: HTMLElement, key: string): () => void {
  const handleScroll = () => writePreviewScroll(key, element.scrollTop);
  element.addEventListener("scroll", handleScroll, { passive: true });
  return () => element.removeEventListener("scroll", handleScroll);
}
