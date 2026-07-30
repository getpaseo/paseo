import { useEffect, useRef, useState } from "react";

import { intersectRects, type AnchorRect } from "@/read-aloud/read-aloud-placement";

export interface SelectionAnchor {
  /** The selected text, captured when the selection settles. */
  text: string;
  /**
   * Caret rect at the selection's start. Null once the range's nodes have
   * detached — the timeline virtualizer unmounts rows outside its overscan —
   * while the anchor is being retained for an in-flight read.
   */
  firstRect: AnchorRect | null;
  /** Caret rect at the selection's end. Null under the same conditions. */
  lastRect: AnchorRect | null;
  /**
   * Window intersected with every clipping ancestor. Client rects ignore
   * ancestor `overflow` entirely, so text scrolled out of the timeline pane
   * still reports a rect inside the window; this is the box that decides what
   * "visible" means.
   */
  visibleBox: AnchorRect;
}

/** Below this a selection is almost certainly a stray click-drag, not a phrase. */
const MIN_SELECTION_CHARS = 2;

/**
 * Marks the bubble subtree so selection tracking can tell "the user pressed the
 * bubble" apart from "the user clicked away". Applied via `dataSet`, which
 * react-native-web renders as `data-read-aloud-bubble`.
 */
export const READ_ALOUD_BUBBLE_DATASET = { readAloudBubble: "" } as const;

const READ_ALOUD_BUBBLE_SELECTOR = "[data-read-aloud-bubble]";

function isInsideReadAloudBubble(target: EventTarget | null): boolean {
  const element = resolveElement(target instanceof Node ? target : null);
  return element?.closest(READ_ALOUD_BUBBLE_SELECTOR) != null;
}

/** How long the selection must hold still (keyboard selection) before we anchor. */
const SETTLE_MS = 180;

/** Computed `overflow` values that clip descendants out of view. */
const CLIPPING_OVERFLOW = new Set(["auto", "scroll", "hidden", "clip"]);

function resolveElement(node: Node | null): HTMLElement | null {
  if (!node) {
    return null;
  }
  if (node instanceof HTMLElement) {
    return node;
  }
  return node.parentElement;
}

/**
 * Read aloud covers agent output, diffs, and file contents — everything except
 * surfaces that own their own selection semantics: form fields (the composer)
 * and the terminal, which already implements copy-on-select over xterm.
 */
function isReadAloudEligible(range: Range): boolean {
  const element = resolveElement(range.commonAncestorContainer);
  if (!element || !element.isConnected) {
    return false;
  }
  return !element.closest(
    'input, textarea, select, [contenteditable=""], [contenteditable="true"], .xterm',
  );
}

function windowRect(): AnchorRect {
  return { top: 0, left: 0, bottom: window.innerHeight, right: window.innerWidth };
}

/**
 * Every ancestor that clips its descendants, nearest first.
 *
 * Recomputed only when the selection settles: the chain itself does not change
 * on scroll, only its rects do, so per-frame cost stays a handful of
 * `getBoundingClientRect()` calls.
 */
function collectClipChain(start: HTMLElement | null): HTMLElement[] {
  const chain: HTMLElement[] = [];
  for (let node = start; node; node = node.parentElement) {
    const style = window.getComputedStyle(node);
    if (CLIPPING_OVERFLOW.has(style.overflowX) || CLIPPING_OVERFLOW.has(style.overflowY)) {
      chain.push(node);
    }
  }
  return chain;
}

function computeVisibleBox(chain: HTMLElement[]): AnchorRect {
  let box = windowRect();
  for (const element of chain) {
    // A clipping ancestor can unmount under a retained anchor; skip it rather
    // than intersecting with the zero rect a detached node reports.
    if (!element.isConnected) {
      continue;
    }
    box = intersectRects(box, element.getBoundingClientRect());
  }
  return box;
}

function toAnchorRect(rect: DOMRect): AnchorRect {
  return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
}

function intersectsRange(range: Range, node: Text): boolean {
  // `comparePoint` is -1 before the range, 0 inside, 1 after.
  return range.comparePoint(node, 0) <= 0 && range.comparePoint(node, node.length) >= 0;
}

/** The first (or last) non-empty text node the range actually covers. */
function findEdgeText(range: Range, atStart: boolean): { node: Text; offset: number } | null {
  const root = range.commonAncestorContainer;
  const scope = root.nodeType === Node.ELEMENT_NODE ? root : root.parentNode;
  if (!scope) {
    return null;
  }

  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  let found: Text | null = null;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.length === 0 || !intersectsRange(range, node)) {
      continue;
    }
    found = node;
    if (atStart) {
      break;
    }
  }
  if (!found) {
    return null;
  }

  const boundary = atStart ? range.startContainer : range.endContainer;
  if (found === boundary) {
    return { node: found, offset: atStart ? range.startOffset : range.endOffset };
  }
  return { node: found, offset: atStart ? 0 : found.length };
}

/**
 * A range positioned at one end of the selection, kept for re-measuring.
 *
 * A collapsed clone rather than `getClientRects()` indexing: that list is not
 * one rect per line — it also carries a rect for every element box fully
 * contained in the range, so a selection spanning a `<p>` contributes that
 * container's full-height box and `rects[0]` can be the entire selection.
 *
 * Chrome reports an empty rect for a collapsed range parked at an element
 * boundary, and a mouse drag that ends between elements produces exactly that:
 * `endOffset === 0` on a `<div>`, with nothing "just inside" to widen toward.
 * Resolving to the nearest covered text node costs a walk, so it happens once
 * when the selection settles and the resulting range is re-measured per frame.
 * Falling back to the whole-selection box instead would reintroduce the
 * container contamination this is avoiding.
 */
function buildEndpointRange(range: Range, atStart: boolean): Range | null {
  const clone = range.cloneRange();
  clone.collapse(atStart);
  // Caret rects are zero-width by construction, so only height is meaningful.
  if (clone.getBoundingClientRect().height > 0) {
    return clone;
  }

  const edge = findEdgeText(range, atStart);
  if (!edge) {
    return null;
  }
  // One character wide: a collapsed range at the same spot would report the
  // same empty rect the clone just did.
  const start = atStart
    ? Math.min(edge.offset, edge.node.length - 1)
    : Math.max(0, edge.offset - 1);
  const sliver = document.createRange();
  sliver.setStart(edge.node, start);
  sliver.setEnd(edge.node, start + 1);
  return sliver;
}

function measureEndpoint(range: Range | null): AnchorRect | null {
  if (!range) {
    return null;
  }
  // A detached range — the virtualizer unmounted its rows — reports zeros.
  const rect = range.getBoundingClientRect();
  return rect.height > 0 ? toAnchorRect(rect) : null;
}

/**
 * Tracks the current text selection as viewport-anchored geometry, web only.
 *
 * The text is captured when the selection settles rather than when the caller
 * acts on it: pressing anything can collapse the selection first, at which point
 * `window.getSelection()` is already empty.
 *
 * `retainWhileDetached` decouples playback lifetime from anchor liveness. Speech
 * needs no live range — the text was captured at settle time — so while
 * something is playing, a selection whose rows the virtualizer unmounted keeps
 * its anchor (with null rects) instead of vanishing and taking the stop control
 * with it.
 */
export function useSelectionAnchor(
  enabled: boolean,
  retainWhileDetached: boolean,
): SelectionAnchor | null {
  const [anchor, setAnchor] = useState<SelectionAnchor | null>(null);
  const pointerDownRef = useRef(false);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frameRef = useRef<number | null>(null);
  const clipChainRef = useRef<HTMLElement[] | null>(null);
  const endpointsRef = useRef<{ start: Range | null; end: Range | null } | null>(null);
  const retainedRef = useRef<SelectionAnchor | null>(null);
  // A ref, not a dependency: flipping retain must not tear down and re-register
  // every document listener mid-playback.
  const retainRef = useRef(retainWhileDetached);
  retainRef.current = retainWhileDetached;

  useEffect(() => {
    if (!enabled) {
      retainedRef.current = null;
      clipChainRef.current = null;
      endpointsRef.current = null;
      setAnchor(null);
      return;
    }

    let observer: ResizeObserver | null = null;

    const clearSettleTimer = () => {
      if (settleTimerRef.current !== null) {
        clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
    };

    const clearFrame = () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };

    const publish = (next: SelectionAnchor | null) => {
      retainedRef.current = next;
      setAnchor(next);
    };

    const observeChain = (chain: HTMLElement[]) => {
      if (typeof ResizeObserver === "undefined") {
        return;
      }
      observer?.disconnect();
      // Neither `scroll` nor `resize` fires on reflow — streaming output,
      // virtualizer row remeasure, dragging the pane resize handle — and all
      // three move the selection under a viewport-positioned bubble.
      observer ??= new ResizeObserver(() => scheduleFrame());
      for (const element of chain) {
        observer.observe(element);
      }
    };

    const readSelection = (resolveEndpoints: boolean): SelectionAnchor | null => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        return null;
      }

      const text = selection.toString().trim();
      if (text.length < MIN_SELECTION_CHARS) {
        return null;
      }

      const range = selection.getRangeAt(0);
      if (!isReadAloudEligible(range)) {
        return null;
      }

      // Both the clipping chain and the endpoint ranges are properties of the
      // selection, not of the scroll position, so they are resolved once when it
      // settles and only re-measured on subsequent frames.
      if (resolveEndpoints || clipChainRef.current === null || endpointsRef.current === null) {
        const chain = collectClipChain(resolveElement(range.startContainer));
        clipChainRef.current = chain;
        observeChain(chain);
        endpointsRef.current = {
          start: buildEndpointRange(range, true),
          end: buildEndpointRange(range, false),
        };
      }

      const firstRect = measureEndpoint(endpointsRef.current.start);
      const lastRect = measureEndpoint(endpointsRef.current.end);
      if (!firstRect && !lastRect) {
        return null;
      }

      return {
        text,
        firstRect,
        lastRect,
        visibleBox: computeVisibleBox(clipChainRef.current),
      };
    };

    const commit = (resolveEndpoints: boolean) => {
      const next = readSelection(resolveEndpoints);
      if (next) {
        publish(next);
        return;
      }

      const retained = retainedRef.current;
      if (retainRef.current && retained) {
        // The range is gone but the read is not. Keep the text and re-measure
        // the box its pane still occupies so the bubble can park at an edge.
        publish({
          ...retained,
          firstRect: null,
          lastRect: null,
          visibleBox: computeVisibleBox(clipChainRef.current ?? []),
        });
        return;
      }

      clipChainRef.current = null;
      endpointsRef.current = null;
      publish(null);
    };

    const scheduleSettled = () => {
      clearSettleTimer();
      settleTimerRef.current = setTimeout(() => {
        settleTimerRef.current = null;
        commit(true);
      }, SETTLE_MS);
    };

    const scheduleFrame = () => {
      if (frameRef.current !== null) {
        return;
      }
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        commit(false);
      });
    };

    const handleSelectionChange = () => {
      // Mid-drag the selection is still moving, so drop the stale anchor and
      // wait for the release rather than flashing a bubble at a moving edge.
      if (pointerDownRef.current) {
        clearSettleTimer();
        publish(null);
        return;
      }
      scheduleSettled();
    };

    const handlePointerDown = (event: Event) => {
      // Pressing the bubble must not dismiss it — that press is the whole point,
      // and the bubble also preventDefaults so the selection itself survives.
      if (isInsideReadAloudBubble(event.target)) {
        return;
      }
      // Explicit intent to leave: this is the one path that drops a retained
      // anchor, and the bubble reads that as "stop". Without it, retention
      // would keep audio playing with no visible way to stop it.
      pointerDownRef.current = true;
      clearSettleTimer();
      publish(null);
    };

    const handlePointerUp = (event: Event) => {
      if (isInsideReadAloudBubble(event.target)) {
        return;
      }
      pointerDownRef.current = false;
      scheduleSettled();
    };

    document.addEventListener("selectionchange", handleSelectionChange);
    document.addEventListener("mousedown", handlePointerDown, true);
    document.addEventListener("mouseup", handlePointerUp, true);
    document.addEventListener("touchend", handlePointerUp, true);
    // Capture phase so nested scrollers are caught too.
    window.addEventListener("scroll", scheduleFrame, true);
    window.addEventListener("resize", scheduleFrame);

    return () => {
      clearSettleTimer();
      clearFrame();
      observer?.disconnect();
      document.removeEventListener("selectionchange", handleSelectionChange);
      document.removeEventListener("mousedown", handlePointerDown, true);
      document.removeEventListener("mouseup", handlePointerUp, true);
      document.removeEventListener("touchend", handlePointerUp, true);
      window.removeEventListener("scroll", scheduleFrame, true);
      window.removeEventListener("resize", scheduleFrame);
    };
  }, [enabled]);

  return anchor;
}
