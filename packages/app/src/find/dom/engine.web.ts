import { centerRange } from "@/find/dom/center-range";
import type { FindEngine, FindResult } from "@/find/engine";
import { clampActiveIndex, stepActiveIndex } from "@/find/model";
import type { FindHighlightRegistry } from "@/find/dom/highlights.web";
import { findTextRanges } from "@/find/dom/text-ranges";

export interface DomFindEngineInput {
  /** The containers to search, re-read on every recompute so roots may come and go. */
  getRoots: () => readonly Element[];
  getScrollElement: () => HTMLElement | null;
  highlights: FindHighlightRegistry;
}

let nextToken = 1;

/**
 * Find over a plain DOM subtree: the Markdown preview in the file pane, and any other
 * surface whose entire searchable text is mounted.
 *
 * The transcript does not use this — its history is virtualized, so most of its text
 * has no DOM at all and its engine searches the loaded stream items instead.
 */
export function createDomFindEngine({
  getRoots,
  getScrollElement,
  highlights,
}: DomFindEngineInput): FindEngine {
  const token = `dom-find-${nextToken++}`;
  const listeners = new Set<(result: FindResult) => void>();
  const observer = new MutationObserver(() => scheduleRecompute());

  let query = "";
  let matches: Range[] = [];
  let activeIndex: number | null = null;
  let observedRoots: readonly Element[] = [];
  let pendingFrame: number | null = null;

  function emit(): void {
    const result: FindResult = { count: matches.length, activeIndex };
    for (const listener of listeners) {
      listener(result);
    }
  }

  function publish(): void {
    highlights.publish(token, {
      matches,
      active: activeIndex === null ? null : matches[activeIndex],
    });
  }

  function observeRoots(roots: readonly Element[]): void {
    if (
      roots.length === observedRoots.length &&
      roots.every((root, index) => root === observedRoots[index])
    ) {
      return;
    }
    observer.disconnect();
    observedRoots = roots;
    for (const root of roots) {
      observer.observe(root, { childList: true, characterData: true, subtree: true });
    }
  }

  function recomputeMatches(): void {
    const roots = getRoots();
    observeRoots(roots);
    matches = findTextRanges({ roots, query });
  }

  /** Coalesced so a burst of mutations costs one search per frame, not one per record. */
  function scheduleRecompute(): void {
    if (pendingFrame !== null) {
      return;
    }
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = null;
      if (query === "") {
        return;
      }
      recomputeMatches();
      activeIndex = clampActiveIndex(activeIndex, matches.length);
      publish();
      emit();
    });
  }

  function activate(index: number | null): void {
    activeIndex = index;
    publish();
    const active = index === null ? null : matches[index];
    const scrollElement = getScrollElement();
    if (active && scrollElement) {
      centerRange(active, scrollElement);
    }
    emit();
  }

  function step(delta: 1 | -1): void {
    activate(stepActiveIndex({ activeIndex, count: matches.length, delta }));
  }

  return {
    setQuery(nextQuery) {
      query = nextQuery;
      if (query === "") {
        matches = [];
        activate(null);
        return;
      }
      recomputeMatches();
      activate(firstMatchInViewport(matches, getScrollElement()));
    },

    next() {
      step(1);
    },

    previous() {
      step(-1);
    },

    clear() {
      query = "";
      matches = [];
      activeIndex = null;
      highlights.release(token);
      emit();
    },

    subscribe(listener) {
      listeners.add(listener);
      listener({ count: matches.length, activeIndex });
      return () => {
        listeners.delete(listener);
      };
    },

    dispose() {
      if (pendingFrame !== null) {
        cancelAnimationFrame(pendingFrame);
        pendingFrame = null;
      }
      observer.disconnect();
      observedRoots = [];
      highlights.release(token);
      listeners.clear();
    },
  };
}

/**
 * The first match at or below the top of the visible area, so typing a query jumps to
 * what the reader is looking at rather than back to the top of the document. Wraps to
 * the first match when everything visible is already behind them.
 */
function firstMatchInViewport(
  matches: readonly Range[],
  scrollElement: HTMLElement | null,
): number | null {
  if (matches.length === 0) {
    return null;
  }
  if (!scrollElement) {
    return 0;
  }
  const top = scrollElement.getBoundingClientRect().top;
  const index = matches.findIndex((range) => range.getBoundingClientRect().bottom >= top);
  return index === -1 ? 0 : index;
}
