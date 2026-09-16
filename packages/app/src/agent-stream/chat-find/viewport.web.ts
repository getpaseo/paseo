import type { ChatFindOperations } from "./model";
import type { ChatFindProps } from "./types";
import { findRenderedMatches } from "./ranges.web";

interface ViewportInput {
  getBindings(): Pick<ChatFindProps, "viewportRef" | "revealLoadedItem" | "visibleItemIds">;
  getRoot(): HTMLElement | null;
  highlightName: string;
}
export function createFindViewport({
  getBindings,
  getRoot,
  highlightName,
}: ViewportInput): Pick<ChatFindOperations, "reveal" | "clear"> {
  return {
    clear() {
      CSS.highlights.delete(highlightName);
    },
    reveal(itemId, query, occurrence, signal) {
      return new Promise((resolve, reject) => {
        let frame = 0;
        let started = false;
        const deadline = performance.now() + 5000;
        const cleanup = () => {
          cancelAnimationFrame(frame);
          signal.removeEventListener("abort", cancelled);
        };
        const cancelled = () => {
          cleanup();
          reject(new Error("Search cancelled"));
        };
        const poll = () => {
          if (signal.aborted) {
            cancelled();
            return;
          }
          if (performance.now() >= deadline) {
            cleanup();
            reject(new Error("Could not reveal this match; retry"));
            return;
          }
          const current = getBindings();
          if (!current.visibleItemIds.has(itemId)) {
            current.revealLoadedItem(itemId);
            frame = requestAnimationFrame(poll);
            return;
          }
          if (!started) {
            current.viewportRef.current?.scrollToMessage?.(itemId);
            started = true;
          }
          const row = getRoot()?.querySelector<HTMLElement>(
            `[data-history-row-id="${CSS.escape(itemId)}"]`,
          );
          if (!row || !row.getBoundingClientRect().height) {
            frame = requestAnimationFrame(poll);
            return;
          }
          const ranges = findRenderedMatches(row, query);
          const index =
            occurrence < 0 ? ranges.length - 1 : Math.min(occurrence, ranges.length - 1);
          const range = ranges[index];
          cleanup();
          if (!range) {
            resolve({ occurrence: 0, count: 0 });
            return;
          }
          current.viewportRef.current?.scrollToMessage?.(itemId, {
            signal,
            targetTop(currentRow) {
              const selected = findRenderedMatches(currentRow, query)[index];
              if (!selected) return null;
              CSS.highlights.set(highlightName, new Highlight(selected));
              const widget = getRoot()?.querySelector<HTMLElement>(
                '[data-chat-find-widget="true"]',
              );
              const clearance = widget ? widget.getBoundingClientRect().height + 8 : 0;
              return selected.getBoundingClientRect().top - clearance;
            },
          });
          CSS.highlights.set(highlightName, new Highlight(range));
          resolve({ occurrence: index, count: ranges.length });
        };
        signal.addEventListener("abort", cancelled, { once: true });
        frame = requestAnimationFrame(poll);
      });
    },
  };
}
