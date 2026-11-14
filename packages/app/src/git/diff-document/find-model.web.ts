import {
  DIFF_FIND_MATCH_LIMIT,
  findDiffMatches,
  resolveDiffMatchGeometry,
  sameDiffMatchIdentity,
  selectedSingleLineDiffText,
  type DiffFindHighlightState,
  type DiffFindMatch,
} from "./find";
import { FILE_HEADER_HEIGHT } from "./model";
import type { DiffDocumentModel, DiffSelection } from "./types";

export type DiffFindPlacement = "top" | "bottom";

export interface DiffFindSnapshot {
  open: boolean;
  placement: DiffFindPlacement;
  query: string;
  current: number;
  total: number;
  limited: boolean;
}

export interface DiffFindHost {
  getModel(): DiffDocumentModel | null;
  getSelection(): DiffSelection | null;
  getRoot(): HTMLDivElement | null;
  getScroll(): HTMLDivElement | null;
  setScrollTop(scrollTop: number): void;
  getHorizontalOffset(path: string): number;
  setHorizontalOffset(fileIndex: number, path: string, offset: number): void;
  requestPaint(): void;
}

const BOTTOM_EDGE_MARGIN = 16;

interface SearchContentSignature {
  query: string;
  limit: number;
  layout: DiffDocumentModel["layout"];
  rowCount: number;
  files: ReadonlyArray<{
    file: DiffDocumentModel["files"][number]["file"];
    path: string;
    headerHeight: number;
    isCollapsed: boolean;
    rowStart: number;
    rowEnd: number;
  }>;
}

function buildSearchContentSignature(
  model: DiffDocumentModel,
  query: string,
  limit: number,
): SearchContentSignature {
  return {
    query,
    limit,
    layout: model.layout,
    rowCount: model.rows.length,
    files: model.files.map((section) => ({
      file: section.file,
      path: section.path,
      headerHeight: section.headerHeight,
      isCollapsed: section.isCollapsed,
      rowStart: section.rowStart,
      rowEnd: section.rowEnd,
    })),
  };
}

function matchesSearchContentSignature(
  signature: SearchContentSignature | null,
  model: DiffDocumentModel | null,
  query: string,
  limit: number,
): boolean {
  if (!signature || !model) return false;
  if (
    signature.query !== query ||
    signature.limit !== limit ||
    signature.layout !== model.layout ||
    signature.rowCount !== model.rows.length ||
    signature.files.length !== model.files.length
  ) {
    return false;
  }
  for (let index = 0; index < signature.files.length; index += 1) {
    const left = signature.files[index]!;
    const right = model.files[index]!;
    if (
      left.file !== right.file ||
      left.path !== right.path ||
      left.headerHeight !== right.headerHeight ||
      left.isCollapsed !== right.isCollapsed ||
      left.rowStart !== right.rowStart ||
      left.rowEnd !== right.rowEnd
    ) {
      return false;
    }
  }
  return true;
}

export class DiffFindModel {
  private listeners = new Set<() => void>();
  private widget: HTMLElement | null = null;
  private widgetResize: ResizeObserver | null = null;
  private matches: DiffFindMatch[] = [];
  private limited = false;
  private activeIndex = -1;
  private pendingExactReveal = false;
  private lastSearchSignature: SearchContentSignature | null = null;
  private snapshot: DiffFindSnapshot = {
    open: false,
    placement: "top",
    query: "",
    current: 0,
    total: 0,
    limited: false,
  };

  constructor(
    private readonly host: DiffFindHost,
    private readonly limit = DIFF_FIND_MATCH_LIMIT,
  ) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = () => this.snapshot;

  readonly isOpen = () => this.snapshot.open;

  readonly getHighlightState = (): DiffFindHighlightState | null => {
    if (!this.snapshot.open || this.matches.length === 0) return null;
    return {
      matches: this.matches,
      activeIndex: this.activeIndex,
    };
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
    const model = this.host.getModel();
    const seed =
      !model ||
      (this.widget && document.activeElement && this.widget.contains(document.activeElement))
        ? null
        : selectedSingleLineDiffText(model, this.host.getSelection());
    const nextQuery = seed ?? this.snapshot.query;
    const queryChanged = nextQuery !== this.snapshot.query;
    const nextPlacement: DiffFindPlacement = wasOpen ? this.snapshot.placement : "top";
    if (!wasOpen || queryChanged) {
      this.recompute({
        open: true,
        placement: nextPlacement,
        query: nextQuery,
        reveal: true,
        preserveIdentity: !queryChanged && wasOpen,
      });
    } else {
      this.commitSnapshot({ open: true, placement: nextPlacement, query: nextQuery });
      this.revealAndReposition();
    }
  };

  readonly close = () => {
    const hadHighlights = this.matches.length > 0;
    this.matches = [];
    this.limited = false;
    this.activeIndex = -1;
    this.pendingExactReveal = false;
    this.lastSearchSignature = null;
    if (hadHighlights) this.host.requestPaint();
    this.commitSnapshot({
      open: false,
      placement: "top",
      current: 0,
      total: 0,
      limited: false,
    });
  };

  readonly dispose = () => {
    this.widgetResize?.disconnect();
    this.widgetResize = null;
  };

  readonly setSearch = (query: string) => {
    if (query === this.snapshot.query && this.snapshot.open) return;
    this.recompute({
      open: this.snapshot.open,
      placement: this.snapshot.placement,
      query,
      reveal: true,
      preserveIdentity: false,
    });
  };

  readonly next = () => {
    if (this.matches.length === 0) return;
    this.activeIndex = (this.activeIndex + 1) % this.matches.length;
    this.syncSnapshotAndPaint({
      open: this.snapshot.open,
      placement: this.snapshot.placement,
      query: this.snapshot.query,
      reveal: true,
    });
  };

  readonly previous = () => {
    if (this.matches.length === 0) return;
    this.activeIndex = this.activeIndex <= 0 ? this.matches.length - 1 : this.activeIndex - 1;
    this.syncSnapshotAndPaint({
      open: this.snapshot.open,
      placement: this.snapshot.placement,
      query: this.snapshot.query,
      reveal: true,
    });
  };

  readonly onModelUpdated = () => {
    if (!this.snapshot.open) return;
    if (!this.snapshot.query) return;
    const model = this.host.getModel();
    if (
      matchesSearchContentSignature(
        this.lastSearchSignature,
        model,
        this.snapshot.query,
        this.limit,
      )
    ) {
      if (this.pendingExactReveal) {
        this.revealAndReposition();
      } else {
        this.reposition();
      }
      this.host.requestPaint();
      return;
    }
    this.recompute({
      open: this.snapshot.open,
      placement: this.snapshot.placement,
      query: this.snapshot.query,
      reveal: this.pendingExactReveal,
      preserveIdentity: true,
    });
  };

  private recompute(options: {
    open: boolean;
    placement: DiffFindPlacement;
    query: string;
    reveal: boolean;
    preserveIdentity: boolean;
  }) {
    const model = this.host.getModel();
    const previousActive = this.matches[this.activeIndex] ?? null;
    const result =
      model && options.open && options.query
        ? findDiffMatches(model, options.query, this.limit)
        : { matches: [], limited: false };
    this.lastSearchSignature =
      model && options.open && options.query
        ? buildSearchContentSignature(model, options.query, this.limit)
        : null;
    this.matches = result.matches;
    this.limited = result.limited;

    if (this.matches.length === 0) {
      this.activeIndex = -1;
      this.pendingExactReveal = false;
    } else if (options.preserveIdentity && previousActive) {
      const preserved = this.matches.findIndex((item) =>
        sameDiffMatchIdentity(item, previousActive),
      );
      this.activeIndex =
        preserved >= 0
          ? preserved
          : Math.min(Math.max(0, this.activeIndex), this.matches.length - 1);
    } else {
      this.activeIndex = this.pickInitialIndex(model, this.matches);
    }
    this.syncSnapshotAndPaint({
      open: options.open,
      placement: options.placement,
      query: options.query,
      reveal: options.reveal,
    });
  }

  private pickInitialIndex(
    model: DiffDocumentModel | null,
    matches: readonly DiffFindMatch[],
  ): number {
    const scroll = this.host.getScroll();
    if (!model || !scroll || scroll.scrollTop <= 1) return 0;
    const minTop = scroll.scrollTop + FILE_HEADER_HEIGHT;
    const found = matches.findIndex((match) => {
      if (match.kind === "header") {
        const file = model.files[match.fileIndex];
        return file ? file.top + file.headerHeight > scroll.scrollTop : false;
      }
      const row = model.rows[match.rowIndex];
      return row ? row.top + row.height > minTop : false;
    });
    return found >= 0 ? found : 0;
  }

  private syncSnapshotAndPaint(options: {
    open: boolean;
    placement: DiffFindPlacement;
    query: string;
    reveal: boolean;
  }) {
    const current = this.activeIndex >= 0 ? this.activeIndex + 1 : 0;
    this.commitSnapshot({
      open: options.open,
      placement: options.placement,
      query: options.query,
      current,
      total: this.matches.length,
      limited: this.matches.length === 0 ? false : this.limited,
    });
    if (options.reveal) {
      this.revealAndReposition();
    } else {
      this.reposition();
    }
    this.host.requestPaint();
  }

  private commitSnapshot(patch: Partial<DiffFindSnapshot>) {
    const next: DiffFindSnapshot = { ...this.snapshot, ...patch };
    if (
      next.open === this.snapshot.open &&
      next.placement === this.snapshot.placement &&
      next.query === this.snapshot.query &&
      next.current === this.snapshot.current &&
      next.total === this.snapshot.total &&
      next.limited === this.snapshot.limited
    ) {
      return;
    }
    this.snapshot = next;
    this.publish();
  }

  private widgetAllowance(rootRect: DOMRect): number {
    if (!this.widget || !this.snapshot.open) return 0;
    const box = this.widget.getBoundingClientRect();
    if (!box.height) return 0;
    const allowance =
      this.snapshot.placement === "top" ? box.bottom - rootRect.top : rootRect.bottom - box.top;
    return Math.max(0, allowance);
  }

  private revealAndReposition() {
    const model = this.host.getModel();
    const scroll = this.host.getScroll();
    const root = this.host.getRoot();
    const active = this.matches[this.activeIndex];
    if (!model || !scroll || !root || !active || !this.snapshot.open) return;
    const geo = resolveDiffMatchGeometry(model, active);
    if (!geo) return;

    this.pendingExactReveal = !geo.materialized;
    const rootRect = root.getBoundingClientRect();
    const viewportHeight = scroll.clientHeight || rootRect.height;
    if (viewportHeight <= 0) return;

    const allowance = this.widgetAllowance(rootRect);
    const topInset =
      this.snapshot.placement === "top"
        ? Math.max(FILE_HEADER_HEIGHT + 8, allowance + 8)
        : FILE_HEADER_HEIGHT + 8;
    const bottomInset =
      this.snapshot.placement === "bottom"
        ? Math.max(BOTTOM_EDGE_MARGIN, allowance + 8)
        : BOTTOM_EDGE_MARGIN;
    const safeTop = scroll.scrollTop + topInset;
    const safeBottom = scroll.scrollTop + viewportHeight - bottomInset;

    if (safeBottom > safeTop) {
      if (geo.top < safeTop) {
        this.host.setScrollTop(Math.max(0, geo.top - topInset));
      } else if (geo.bottom > safeBottom) {
        const maxScrollTop = Math.max(0, scroll.scrollHeight - viewportHeight);
        this.host.setScrollTop(Math.min(maxScrollTop, geo.bottom - (viewportHeight - bottomInset)));
      }
    }

    if (!model.wrapLines && geo.materialized) {
      const currentH = this.host.getHorizontalOffset(active.path);
      const nextH = geo.desiredHorizontalOffset(currentH);
      if (nextH !== currentH) {
        this.host.setHorizontalOffset(active.fileIndex, active.path, nextH);
      }
    }

    this.reposition();
  }

  private reposition() {
    const model = this.host.getModel();
    const scroll = this.host.getScroll();
    const root = this.host.getRoot();
    const active = this.matches[this.activeIndex];
    if (!model || !scroll || !root || !this.widget || !active || !this.snapshot.open) return;
    const geo = resolveDiffMatchGeometry(model, active);
    if (!geo) return;

    const box = this.widget.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    if (!box.height || !box.width || !rootRect.height) return;
    const allowance = this.widgetAllowance(rootRect);
    if (!allowance) return;

    const hOffset = this.host.getHorizontalOffset(active.path);
    const match = {
      left: rootRect.left + geo.screenLeft(hOffset),
      right: rootRect.left + geo.screenRight(hOffset),
      top: rootRect.top + (geo.top - scroll.scrollTop),
      bottom: rootRect.top + (geo.bottom - scroll.scrollTop),
    };
    const current = this.snapshot.placement;
    const hits = (placement: DiffFindPlacement) => {
      if (match.right <= box.left || match.left >= box.right) return false;
      return placement === "top"
        ? match.top < rootRect.top + allowance && match.bottom > rootRect.top
        : match.bottom > rootRect.bottom - allowance && match.top < rootRect.bottom;
    };
    if (!hits(current)) return;
    const other: DiffFindPlacement = current === "top" ? "bottom" : "top";
    if (hits(other)) return;
    this.commitSnapshot({ placement: other });
  }

  private publish() {
    for (const listener of this.listeners) listener();
  }
}
