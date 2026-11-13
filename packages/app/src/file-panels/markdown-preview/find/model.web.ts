import {
  findMarkdownPreviewMatches,
  MATCH_STATUS_LIMIT,
  selectedSingleLineText,
} from "./ranges.web";

export type FindPlacement = "top" | "bottom";

export interface MarkdownPreviewFindSnapshot {
  open: boolean;
  placement: FindPlacement;
  query: string;
  current: number;
  total: number;
  limited: boolean;
}

const EDGE_MARGIN = 16;

function supportsCssHighlights(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
}

function rangeRect(range: Range): DOMRect | null {
  const first = range.getClientRects()[0];
  if (first && (first.width > 0 || first.height > 0)) return first;
  const box = range.getBoundingClientRect();
  return box.width > 0 || box.height > 0 ? box : null;
}

export interface MarkdownPreviewFindModelOptions {
  limit?: number;
  useCssHighlights?: boolean;
}

export class MarkdownPreviewFindModel {
  private readonly limit: number;
  private readonly useCssHighlights: boolean;
  private listeners = new Set<() => void>();
  private root: HTMLElement | null = null;
  private widget: HTMLElement | null = null;
  private widgetResize: ResizeObserver | null = null;
  private paneInteractive = true;
  private ranges: Range[] = [];
  private fallbackSelectedRange: Range | null = null;
  private limited = false;
  private activeIndex = -1;
  private snapshot: MarkdownPreviewFindSnapshot = {
    open: false,
    placement: "top",
    query: "",
    current: 0,
    total: 0,
    limited: false,
  };

  constructor(
    private readonly highlightNames: {
      all: string;
      active: string;
    },
    options: MarkdownPreviewFindModelOptions | number = {},
  ) {
    if (typeof options === "number") {
      this.limit = options;
      this.useCssHighlights = supportsCssHighlights();
    } else {
      this.limit = options.limit ?? MATCH_STATUS_LIMIT;
      this.useCssHighlights = options.useCssHighlights ?? supportsCssHighlights();
    }
  }

  readonly setPaneInteractive = (interactive: boolean) => {
    this.paneInteractive = interactive;
  };

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = () => this.snapshot;

  readonly setRootNode = (node: HTMLElement | null) => {
    if (this.root === node) return;
    this.root = node;
    if (!node) {
      this.clearHighlights();
      return;
    }
    if (this.snapshot.open && this.snapshot.query) {
      this.recompute({ reveal: false, preserveIndex: true });
    }
  };

  readonly setWidgetNode = (node: HTMLElement | null) => {
    if (this.widget === node) return;
    this.widgetResize?.disconnect();
    this.widgetResize = null;
    this.widget = node;
    if (!node) return;
    if (typeof ResizeObserver !== "undefined") {
      this.widgetResize = new ResizeObserver(() => this.revealAndReposition());
      this.widgetResize.observe(node);
    }
    this.revealAndReposition();
  };

  readonly open = () => {
    const wasOpen = this.snapshot.open;
    const frame = this.frameElement();
    const seed =
      (this.widget && document.activeElement && this.widget.contains(document.activeElement)) ||
      this.isOwnFallbackSelection()
        ? null
        : selectedSingleLineText(frame);
    const nextQuery = seed ?? this.snapshot.query;
    const queryChanged = nextQuery !== this.snapshot.query;
    this.snapshot = {
      ...this.snapshot,
      open: true,
      placement: wasOpen ? this.snapshot.placement : "top",
      query: nextQuery,
    };
    if (!wasOpen || queryChanged) {
      this.recompute({ reveal: true, preserveIndex: !queryChanged && wasOpen });
    } else {
      this.publish();
      this.revealAndReposition();
    }
  };

  readonly close = () => {
    this.ranges = [];
    this.limited = false;
    this.activeIndex = -1;
    this.clearHighlights();
    if (!this.snapshot.open && this.snapshot.placement === "top") return;
    this.snapshot = {
      ...this.snapshot,
      open: false,
      placement: "top",
    };
    this.publish();
  };

  readonly dispose = () => {
    this.widgetResize?.disconnect();
    this.widgetResize = null;
    this.clearHighlights();
  };

  readonly setSearch = (query: string) => {
    if (query === this.snapshot.query && this.snapshot.open) return;
    this.snapshot = {
      ...this.snapshot,
      query,
    };
    this.recompute({ reveal: true, preserveIndex: false });
  };

  readonly next = () => {
    if (this.ranges.length === 0) return;
    this.activeIndex = (this.activeIndex + 1) % this.ranges.length;
    this.syncActiveMatch({ reveal: true });
  };

  readonly previous = () => {
    if (this.ranges.length === 0) return;
    this.activeIndex = this.activeIndex <= 0 ? this.ranges.length - 1 : this.activeIndex - 1;
    this.syncActiveMatch({ reveal: true });
  };

  readonly refreshContent = () => {
    if (!this.snapshot.open || !this.snapshot.query) return;
    this.recompute({ reveal: false, preserveIndex: true });
  };

  private frameElement(): HTMLElement | null {
    return this.root?.querySelector<HTMLElement>('[data-testid="markdown-preview-frame"]') ?? null;
  }

  private scrollElement(): HTMLElement | null {
    return this.root?.querySelector<HTMLElement>('[data-testid="markdown-preview-scroll"]') ?? null;
  }

  private recompute(options: { reveal: boolean; preserveIndex: boolean }) {
    const frame = this.frameElement();
    const { ranges, limited } = this.snapshot.open
      ? findMarkdownPreviewMatches(frame, this.snapshot.query, this.limit)
      : { ranges: [], limited: false };
    this.ranges = ranges;
    this.limited = limited;
    if (ranges.length === 0) {
      this.activeIndex = -1;
    } else if (options.preserveIndex && this.activeIndex >= 0) {
      this.activeIndex = Math.min(this.activeIndex, ranges.length - 1);
    } else {
      this.activeIndex = this.pickInitialIndex(ranges);
    }
    this.syncActiveMatch({ reveal: options.reveal });
  }

  private pickInitialIndex(ranges: Range[]): number {
    const scrollEl = this.scrollElement();
    if (!scrollEl || scrollEl.scrollTop <= 1) return 0;
    const scrollTopEdge = scrollEl.getBoundingClientRect().top;
    const visibleIndex = ranges.findIndex((range) => {
      const rect = rangeRect(range);
      return rect ? rect.bottom > scrollTopEdge : false;
    });
    return visibleIndex >= 0 ? visibleIndex : 0;
  }

  private syncActiveMatch(options: { reveal: boolean }) {
    const current = this.activeIndex >= 0 ? this.activeIndex + 1 : 0;
    this.snapshot = {
      ...this.snapshot,
      current,
      total: this.ranges.length,
      limited: this.ranges.length === 0 ? false : this.limited,
    };
    this.applyHighlights({ allowClaimSelection: options.reveal });
    this.publish();
    if (options.reveal) {
      this.revealAndReposition();
    } else {
      this.reposition();
    }
  }

  private isOwnFallbackSelection(): boolean {
    const own = this.fallbackSelectedRange;
    if (!own || typeof window === "undefined") return false;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount !== 1) return false;
    const current = selection.getRangeAt(0);
    return (
      current.startContainer === own.startContainer &&
      current.startOffset === own.startOffset &&
      current.endContainer === own.endContainer &&
      current.endOffset === own.endOffset
    );
  }

  private canMutateFallbackSelection(allowClaimSelection: boolean): boolean {
    if (!this.paneInteractive) return false;
    if (allowClaimSelection || this.isOwnFallbackSelection()) return true;
    const activeElement = typeof document !== "undefined" ? document.activeElement : null;
    return Boolean(
      activeElement && (this.root?.contains(activeElement) || this.widget?.contains(activeElement)),
    );
  }

  private applyHighlights(options: { allowClaimSelection: boolean }) {
    if (!this.snapshot.open || this.ranges.length === 0) {
      this.clearHighlights();
      return;
    }
    if (!this.useCssHighlights) {
      if (!this.canMutateFallbackSelection(options.allowClaimSelection)) return;
      const selection = typeof window !== "undefined" ? window.getSelection() : null;
      if (!selection) return;
      const active = this.ranges[this.activeIndex];
      if (!active) {
        this.clearHighlights();
        return;
      }
      const range = active.cloneRange();
      selection.removeAllRanges();
      selection.addRange(range);
      this.fallbackSelectedRange = range;
      return;
    }
    CSS.highlights.set(this.highlightNames.all, new Highlight(...this.ranges));
    const active = this.ranges[this.activeIndex];
    if (active) {
      CSS.highlights.set(this.highlightNames.active, new Highlight(active));
    } else {
      CSS.highlights.delete(this.highlightNames.active);
    }
  }

  private clearHighlights() {
    if (this.useCssHighlights) {
      CSS.highlights.delete(this.highlightNames.all);
      CSS.highlights.delete(this.highlightNames.active);
    }
    if (this.fallbackSelectedRange) {
      if (this.isOwnFallbackSelection()) {
        window.getSelection()?.removeAllRanges();
      }
      this.fallbackSelectedRange = null;
    }
  }

  private widgetAllowance(scrollRect: DOMRect): number {
    const widget = this.widget;
    if (!widget || !this.snapshot.open) return 0;
    const box = widget.getBoundingClientRect();
    if (!box.height) return 0;
    const allowance =
      this.snapshot.placement === "top" ? box.bottom - scrollRect.top : scrollRect.bottom - box.top;
    return Math.max(0, allowance);
  }

  private revealAndReposition() {
    const scrollEl = this.scrollElement();
    const active = this.ranges[this.activeIndex];
    if (!scrollEl || !active || !this.snapshot.open) return;
    const scrollRect = scrollEl.getBoundingClientRect();
    const match = rangeRect(active);
    if (!match || scrollRect.height <= 0) return;

    const allowance = this.widgetAllowance(scrollRect);
    const topPadding =
      this.snapshot.placement === "top" ? Math.max(EDGE_MARGIN, allowance + 8) : EDGE_MARGIN;
    const bottomPadding =
      this.snapshot.placement === "bottom" ? Math.max(EDGE_MARGIN, allowance + 8) : EDGE_MARGIN;

    const safeTop = scrollRect.top + topPadding;
    const safeBottom = scrollRect.bottom - bottomPadding;

    if (safeBottom > safeTop) {
      if (match.top < safeTop) {
        scrollEl.scrollTop = Math.max(0, scrollEl.scrollTop + (match.top - safeTop));
      } else if (match.bottom > safeBottom) {
        const maxScrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
        scrollEl.scrollTop = Math.min(
          maxScrollTop,
          scrollEl.scrollTop + (match.bottom - safeBottom),
        );
      }
    } else {
      const centerOffset = match.top + match.height / 2 - (scrollRect.top + scrollRect.height / 2);
      scrollEl.scrollTop = Math.max(0, scrollEl.scrollTop + centerOffset);
    }

    this.reposition();
  }

  private reposition() {
    const scrollEl = this.scrollElement();
    const widget = this.widget;
    const active = this.ranges[this.activeIndex];
    if (!scrollEl || !widget || !active || !this.snapshot.open) return;
    const box = widget.getBoundingClientRect();
    if (!box.height || !box.width) return;
    const scrollRect = scrollEl.getBoundingClientRect();
    const match = rangeRect(active);
    if (!match) return;
    const allowance = this.widgetAllowance(scrollRect);
    if (!allowance) return;

    const current = this.snapshot.placement;
    const hits = (placement: FindPlacement) => {
      if (match.right <= box.left || match.left >= box.right) return false;
      return placement === "top"
        ? match.top < scrollRect.top + allowance && match.bottom > scrollRect.top
        : match.bottom > scrollRect.bottom - allowance && match.top < scrollRect.bottom;
    };
    if (!hits(current)) return;
    const other: FindPlacement = current === "top" ? "bottom" : "top";
    if (hits(other)) return;
    this.snapshot = { ...this.snapshot, placement: other };
    this.publish();
  }

  private publish() {
    for (const listener of this.listeners) listener();
  }
}
