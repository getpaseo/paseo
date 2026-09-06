import type { StreamViewportHandle } from "@/agent-stream/strategy";
import { centerRange } from "@/find/dom/center-range";
import type { FindEngine, FindResult } from "@/find/engine";
import type { FindHighlightRegistry } from "@/find/dom/highlights.web";
import { findTextRanges } from "@/find/dom/text-ranges";
import { stepActiveIndex } from "@/find/model";
import { FIND_TEXT_SELECTOR } from "./markers";
import {
  buildTranscriptFindIndex,
  EMPTY_TRANSCRIPT_FIND_INDEX,
  firstMatchAtOrAfter,
  locate,
  resolveMatch,
  type TranscriptFindIndex,
  type TranscriptFindItem,
  type TranscriptFindMatch,
} from "./index";

export interface TranscriptFindEngine extends FindEngine {
  /** Re-counts against the loaded items, which grow while the bar is open. */
  refreshItems(): void;
}

export interface TranscriptFindEngineInput {
  getItems: () => readonly TranscriptFindItem[];
  /**
   * Dereferenced on every call: the viewport handle object is replaced whenever its
   * callbacks change identity, and the viewport itself remounts per agent.
   */
  getViewport: () => StreamViewportHandle | null;
  highlights: FindHighlightRegistry;
}

/**
 * Where the active match lands after the loaded items changed under an open bar: the
 * same occurrence in the same row when it survived, otherwise the nearest position
 * the new count still has.
 */
function resolveRefreshedActiveIndex(input: {
  index: TranscriptFindIndex;
  previous: TranscriptFindMatch | null;
  previousIndex: number | null;
}): number | null {
  const { index, previous, previousIndex } = input;
  if (previous === null || index.total === 0) {
    return null;
  }
  const relocated = locate(index, previous.itemId, previous.occurrence);
  if (relocated !== null) {
    return relocated;
  }
  return Math.min(previousIndex ?? 0, index.total - 1);
}

const ROW_ID_ATTRIBUTE = "data-history-row-id";

/** A virtualized row needs a few frames to mount and measure after a scroll. */
const ROW_WAIT_FRAMES = 30;

/**
 * How many consecutive rows may disagree with the index before a step gives up. If this
 * many rows in a row hold no DOM range for a match the index counted, the projection is
 * broken and walking the rest of the transcript would only freeze the frame.
 */
const PROJECTION_MISMATCH_BUDGET = 8;

interface RowRanges {
  /** The element the ranges were measured in, so a remounted row is recomputed. */
  element: Element;
  ranges: Range[];
}

let nextToken = 1;

/**
 * Find over an agent transcript.
 *
 * Counts and navigation come from the loaded stream items, not the DOM: past ~100
 * items the history is virtualized, so most of what the user can scroll to has no
 * DOM at all. The DOM is only asked where a match is once its row is mounted, which
 * is why every step reveals the row first and then resolves the range inside it.
 */
export function createTranscriptFindEngine({
  getItems,
  getViewport,
  highlights,
}: TranscriptFindEngineInput): TranscriptFindEngine {
  const token = `transcript-find-${nextToken++}`;
  const listeners = new Set<(result: FindResult) => void>();
  const rowRanges = new Map<string, RowRanges>();
  const changedRowIds = new Set<string>();
  const observer = new MutationObserver(recordMutations);

  let query = "";
  let index: TranscriptFindIndex = EMPTY_TRANSCRIPT_FIND_INDEX;
  let activeIndex: number | null = null;
  let activeRange: Range | null = null;
  let travel: 1 | -1 = 1;
  let observedScroller: HTMLElement | null = null;
  let pendingFrame: number | null = null;
  let activation = 0;

  function getScrollElement(): HTMLElement | null {
    return getViewport()?.getScrollElement?.() ?? null;
  }

  function emit(): void {
    const result: FindResult = { count: index.total, activeIndex };
    for (const listener of listeners) {
      listener(result);
    }
  }

  function publish(): void {
    const matches: Range[] = [];
    for (const row of rowRanges.values()) {
      matches.push(...row.ranges);
    }
    highlights.publish(token, { matches, active: activeRange });
  }

  function streamingRowIds(): Set<string> {
    const streaming = new Set<string>();
    for (const entry of getItems()) {
      if (entry.isStreaming) {
        streaming.add(entry.item.id);
      }
    }
    return streaming;
  }

  function measureRow(row: Element): Range[] {
    return findTextRanges({ roots: [...row.querySelectorAll(FIND_TEXT_SELECTOR)], query });
  }

  /**
   * Rebuilds the per-row range cache. `changed` limits the expensive part to the rows
   * a mutation touched; rows that appeared, disappeared or were remounted by the
   * virtualizer are picked up from the element identity check regardless.
   */
  function syncRowRanges(changed: ReadonlySet<string> | null): void {
    const scroller = getScrollElement();
    if (!scroller || query === "") {
      rowRanges.clear();
      return;
    }
    const streaming = streamingRowIds();
    const present = new Set<string>();
    for (const row of scroller.querySelectorAll(`[${ROW_ID_ATTRIBUTE}]`)) {
      const rowId = row.getAttribute(ROW_ID_ATTRIBUTE);
      if (rowId === null) {
        continue;
      }
      present.add(rowId);
      const cached = rowRanges.get(rowId);
      if (cached?.element === row && changed !== null && !changed.has(rowId)) {
        continue;
      }
      rowRanges.set(rowId, {
        element: row,
        ranges: streaming.has(rowId) ? [] : measureRow(row),
      });
    }
    for (const rowId of rowRanges.keys()) {
      if (!present.has(rowId)) {
        rowRanges.delete(rowId);
      }
    }
  }

  /**
   * Re-points the active range at the freshly measured range for the same match, so
   * the highlight registry can exclude it from the plain-match set by identity.
   */
  function rebindActiveRange(): void {
    activeRange = null;
    if (activeIndex === null) {
      return;
    }
    const match = resolveMatch(index, activeIndex);
    if (!match) {
      return;
    }
    // Not clamped onto the last range: a row whose DOM holds fewer ranges than the index
    // counted would otherwise get an unrelated occurrence marked and named "k of N".
    activeRange = rowRanges.get(match.itemId)?.ranges[match.occurrence] ?? null;
  }

  function observeScroller(): void {
    const scroller = getScrollElement();
    if (scroller === observedScroller) {
      return;
    }
    observer.disconnect();
    observedScroller = scroller;
    if (scroller) {
      observer.observe(scroller, { childList: true, characterData: true, subtree: true });
    }
  }

  function recordMutations(records: MutationRecord[]): void {
    for (const record of records) {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      const rowId = target?.closest(`[${ROW_ID_ATTRIBUTE}]`)?.getAttribute(ROW_ID_ATTRIBUTE);
      if (rowId) {
        changedRowIds.add(rowId);
      }
      // A record whose target is above every row (the virtualizer swapping its window)
      // adds nothing; the element identity check in syncRowRanges catches those.
    }
    scheduleSync();
  }

  /** One resync per frame, however many records a burst of text chunks produced. */
  function scheduleSync(): void {
    if (pendingFrame !== null) {
      return;
    }
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = null;
      if (query === "") {
        return;
      }
      const changed = new Set(changedRowIds);
      changedRowIds.clear();
      syncRowRanges(changed);
      rebindActiveRange();
      publish();
    });
  }

  /** The topmost row still visible, which is where a fresh query starts looking. */
  function firstVisibleRowId(): string | null {
    const scroller = getScrollElement();
    if (!scroller) {
      return null;
    }
    const top = scroller.getBoundingClientRect().top;
    let bestId: string | null = null;
    let bestTop = Number.POSITIVE_INFINITY;
    // Virtualized rows are absolutely positioned, so DOM order is not visual order.
    for (const row of scroller.querySelectorAll(`[${ROW_ID_ATTRIBUTE}]`)) {
      const rect = row.getBoundingClientRect();
      // Strictly below: a row whose bottom edge sits on the viewport top is scrolled past.
      if (rect.bottom > top && rect.top < bestTop) {
        bestTop = rect.top;
        bestId = row.getAttribute(ROW_ID_ATTRIBUTE);
      }
    }
    return bestId;
  }

  function findRowElement(itemId: string): Element | null {
    const scroller = getScrollElement();
    return scroller?.querySelector(`[${ROW_ID_ATTRIBUTE}="${CSS.escape(itemId)}"]`) ?? null;
  }

  /**
   * Settles on a match: reveal its row, wait for the virtualizer to mount it, then mark
   * the range. A row whose DOM holds no range for the match — a projection the renderer
   * disagreed with — hands the step on to the next match in the direction of travel,
   * for PROJECTION_MISMATCH_BUDGET rows before giving up.
   */
  function activate(k: number | null): void {
    activation += 1;
    const generation = activation;
    activeIndex = k;
    const first = k === null ? null : resolveMatch(index, k);
    if (k === null || first === null) {
      activeRange = null;
      publish();
      emit();
      return;
    }
    emit();
    getViewport()?.revealRow?.(first.itemId);

    let current = k;
    let match = first;
    let attemptsLeft = PROJECTION_MISMATCH_BUDGET;
    let framesLeft = ROW_WAIT_FRAMES;

    // Drops the previous match's mark rather than leaving it on while the counter
    // already names a different one.
    const giveUp = () => {
      activeRange = null;
      publish();
    };

    const settle = () => {
      if (generation !== activation) {
        return;
      }
      // A loop rather than a re-entry: with a projection the DOM disagrees with on every
      // row, recursing cost one stack frame per loaded match and blew the stack instead
      // of degrading to "no match found".
      while (true) {
        const row = findRowElement(match.itemId);
        if (!row) {
          framesLeft -= 1;
          if (framesLeft > 0) {
            requestAnimationFrame(settle);
          } else {
            giveUp();
          }
          return;
        }
        const ranges = measureRow(row);
        rowRanges.set(match.itemId, { element: row, ranges });
        const range = ranges[match.occurrence];
        if (range) {
          activeRange = range;
          publish();
          const scroller = getScrollElement();
          if (scroller) {
            centerRange(range, scroller);
          }
          return;
        }
        attemptsLeft -= 1;
        const next = stepActiveIndex({ activeIndex: current, count: index.total, delta: travel });
        if (attemptsLeft <= 0 || next === null || next === k) {
          giveUp();
          return;
        }
        const nextMatch = resolveMatch(index, next);
        if (nextMatch === null) {
          giveUp();
          return;
        }
        current = next;
        match = nextMatch;
        activeIndex = next;
        framesLeft = ROW_WAIT_FRAMES;
        emit();
        getViewport()?.revealRow?.(match.itemId);
      }
    };
    settle();
  }

  function step(delta: 1 | -1): void {
    travel = delta;
    activate(stepActiveIndex({ activeIndex, count: index.total, delta }));
  }

  function reset(): void {
    activation += 1;
    query = "";
    index = EMPTY_TRANSCRIPT_FIND_INDEX;
    activeIndex = null;
    activeRange = null;
    rowRanges.clear();
    changedRowIds.clear();
    // An open bar whose query was emptied must stop resolving a streaming agent's
    // mutation records to rows for a search nobody is running. The next non-empty query
    // re-attaches through observeScroller.
    observer.disconnect();
    observedScroller = null;
  }

  return {
    setQuery(nextQuery) {
      query = nextQuery;
      travel = 1;
      if (query === "") {
        reset();
        highlights.release(token);
        emit();
        return;
      }
      observeScroller();
      index = buildTranscriptFindIndex(getItems(), query);
      const seedRow = firstVisibleRowId();
      syncRowRanges(null);
      publish();
      const seed = seedRow === null ? null : firstMatchAtOrAfter(index, seedRow);
      activate(seed ?? (index.total > 0 ? 0 : null));
    },

    next() {
      step(1);
    },

    previous() {
      step(-1);
    },

    refreshItems() {
      if (query === "") {
        return;
      }
      const previous = activeIndex === null ? null : resolveMatch(index, activeIndex);
      const previousIndex = activeIndex;
      observeScroller();
      index = buildTranscriptFindIndex(getItems(), query);
      activeIndex = resolveRefreshedActiveIndex({ index, previous, previousIndex });
      syncRowRanges(null);
      rebindActiveRange();
      publish();
      emit();
    },

    clear() {
      reset();
      highlights.release(token);
      emit();
    },

    subscribe(listener) {
      listeners.add(listener);
      listener({ count: index.total, activeIndex });
      return () => {
        listeners.delete(listener);
      };
    },

    dispose() {
      if (pendingFrame !== null) {
        cancelAnimationFrame(pendingFrame);
        pendingFrame = null;
      }
      reset();
      highlights.release(token);
      listeners.clear();
    },
  };
}
